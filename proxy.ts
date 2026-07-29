// keelcode-proxy: 本地代理，让 Claude Code 等标准 Anthropic 客户端走 keelcode 托管 API
// 用法: bun run proxy.ts [--port 8082]
// 然后设: ANTHROPIC_BASE_URL=http://localhost:8082  ANTHROPIC_API_KEY=anything

import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || "8082");
const UPSTREAM = "https://api.keelcode.ai";
const SCRIPT_DIR = import.meta.dir;
const DEBUG_LOG = join(SCRIPT_DIR, "proxy-debug.log");

// ── 凭证目录：--creds-dir 或默认 ./credentials ─────────
const CREDS_DIR = process.argv.find((_, i, a) => a[i - 1] === "--creds-dir") || join(SCRIPT_DIR, "credentials");

// ── 多账号凭证池 ─────────────────────────────────────
interface Account {
  file: string;          // 凭证文件路径
  label: string;         // 账号名（文件名）
  accessToken: string;
  expiresAt: string;
  bad?: boolean;         // 401 标记为坏
  cooldownUntil?: number; // 429 冷却时间戳
}

class CredentialPool {
  private accounts: Account[] = [];
  private idx = 0; // round-robin 指针

  load() {
    this.accounts = [];

    // 1. 从凭证目录加载
    if (existsSync(CREDS_DIR)) {
      const files = readdirSync(CREDS_DIR).filter(f => f.endsWith(".json") && !f.startsWith("."));
      for (const f of files) {
        const fp = join(CREDS_DIR, f);
        try {
          const cred = JSON.parse(readFileSync(fp, "utf-8"));
          if (cred.accessToken) {
            this.accounts.push({
              file: fp,
              label: f.replace(/\.json$/, ""),
              accessToken: cred.accessToken,
              expiresAt: cred.expiresAt || "",
            });
          }
        } catch {
          console.error(`[pool] failed to parse ${f}`);
        }
      }
    }

    // 2. fallback: 默认 ~/.keelcode/credentials.json
    const defaultPath = join(homedir(), ".keelcode", "credentials.json");
    if (existsSync(defaultPath)) {
      try {
        const cred = JSON.parse(readFileSync(defaultPath, "utf-8"));
        if (cred.accessToken && !this.accounts.some(a => a.accessToken === cred.accessToken)) {
          this.accounts.push({
            file: defaultPath,
            label: "default",
            accessToken: cred.accessToken,
            expiresAt: cred.expiresAt || "",
          });
        }
      } catch {}
    }

    if (this.accounts.length === 0) {
      console.error(`[pool] no credentials found in ${CREDS_DIR}`);
      console.error("[pool] put keelcode credentials.json files there, or run `keelcode login`");
      process.exit(1);
    }

    console.error(`[pool] loaded ${this.accounts.length} account(s):`);
    for (const a of this.accounts) {
      const exp = a.expiresAt ? new Date(a.expiresAt) : null;
      const valid = !exp || exp > new Date();
      console.error(`  ${a.label}: ${valid ? "valid" : "EXPIRED"} (file: ${a.file})`);
    }
  }

  /** 取下一个可用 token（round-robin，跳过 expired/bad/cooldown） */
  pick(): Account | null {
    const n = this.accounts.length;
    for (let i = 0; i < n; i++) {
      const a = this.accounts[this.idx % n];
      this.idx++;

      if (a.bad) continue;
      if (a.cooldownUntil && Date.now() < a.cooldownUntil) continue;

      // 检查过期
      if (a.expiresAt) {
        const exp = new Date(a.expiresAt);
        if (exp <= new Date()) {
          console.error(`[pool] ${a.label} token expired, skipping`);
          a.bad = true;
          continue;
        }
      }
      return a;
    }
    return null; // 全部不可用
  }

  /** 401 → 标记为坏 */
  markBad(label: string) {
    const a = this.accounts.find(x => x.label === label);
    if (a) {
      a.bad = true;
      console.error(`[pool] ${label} marked BAD (401)`);
    }
  }

  /** 429 → 冷却 60 秒 */
  cooldown(label: string, ms = 60000) {
    const a = this.accounts.find(x => x.label === label);
    if (a) {
      a.cooldownUntil = Date.now() + ms;
      console.error(`[pool] ${label} cooling down ${ms / 1000}s (429)`);
    }
  }

  /** 重新加载（热刷新凭证文件） */
  reload() {
    this.load();
  }

  get count() { return this.accounts.length; }
  get availableCount() {
    return this.accounts.filter(a => !a.bad && (!a.cooldownUntil || Date.now() >= a.cooldownUntil)).length;
  }
}

const pool = new CredentialPool();
pool.load();

// ── 模型映射: 标准 Anthropic 名 → keelcode 名 ─────────
const MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "claude-opus-4-20250514":   "claude-opus-4-8",
  "claude-sonnet-5-20250514": "claude-sonnet-5",
  "claude-haiku-4-20250514":  "haiku-4",
  "claude-3-5-haiku-20241022": "haiku-4",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4-6",
};

function mapModel(model: string): string {
  if (MODEL_MAP[model]) return MODEL_MAP[model];
  // 模糊匹配: claude-sonnet-4-xxx → claude-sonnet-4-6
  for (const [pattern, target] of Object.entries(MODEL_MAP)) {
    const prefix = pattern.replace(/-\d{8}$/, "");
    if (model.startsWith(prefix)) return target;
  }
  return model; // 已经是 keelcode 名或未知模型，直接透传
}

// ── content 格式修正: string → [{type:"text",text}] ───
function normalizeContent(content: unknown): unknown {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

// ── 递归剥掉 cache_control（keelcode 不支持）─────────
function stripCacheControl(obj: any): any {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripCacheControl);
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "cache_control") continue;
    out[k] = stripCacheControl(v);
  }
  return out;
}

function normalizeBody(body: any): any {
  const b = { ...body };

  // 模型映射
  if (b.model) b.model = mapModel(b.model);

  // keelcode 只支持 stream:true
  b.stream = true;

  // 按模型限制 max_tokens（Claude Code 默认发 32000，很多模型超上限）
  const MAX_TOKENS_CAP: Record<string, number> = {
    "kimi-k3": 12000,
    "deepseek-v4-pro": 12000,
    "deepseek-v4-flash": 12000,
    "glm-5.2": 12000,
    "haiku-4": 8192,
  };
  const cap = MAX_TOKENS_CAP[b.model] ?? 16384;
  if (b.max_tokens > cap) b.max_tokens = cap;

  // messages content 格式化 + 剥 cache_control + 处理 system role
  if (Array.isArray(b.messages)) {
    const systemMsgs: any[] = [];
    b.messages = b.messages
      .filter((m: any) => {
        if (m.role === "system") {
          systemMsgs.push(m);
          return false;
        }
        return true;
      })
      .map((m: any) => ({
        ...m,
        content: stripCacheControl(normalizeContent(m.content)),
      }));
    // 把 system role 消息合并到顶层 system
    if (systemMsgs.length > 0) {
      const extra = systemMsgs.flatMap((m) =>
        Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]
      );
      b.system = [...(Array.isArray(b.system) ? b.system : []), ...extra];
    }
  }

  // system: string → array，并剥 cache_control
  if (typeof b.system === "string") {
    b.system = [{ type: "text", text: b.system }];
  } else if (Array.isArray(b.system)) {
    b.system = stripCacheControl(b.system);
  }

  // tools 里的 cache_control 也剥 + 修复缺失的 type 字段 + 截断超长 description
  if (Array.isArray(b.tools)) {
    b.tools = stripCacheControl(b.tools);
    for (const tool of b.tools) {
      // 截断 description（keelcode 限制 ~16000 字符）
      if (tool.description && tool.description.length > 16000) {
        tool.description = tool.description.slice(0, 16000);
      }
      if (tool.input_schema?.properties) {
        for (const prop of Object.values(tool.input_schema.properties)) {
          if (prop && typeof prop === "object" && !("type" in prop)) {
            prop.type = "string";
          }
        }
      }
    }
  }

  // 删掉 keelcode 大概率不认的字段
  delete b.metadata;
  delete b.service_tier;
  delete b.mcp_servers;
  delete b.context_management;
  delete b.output_config;

  // thinking: 非 Claude 模型不支持 extended thinking，直接删
  const isClaude = /^claude/.test(b.model);
  if (b.thinking && !isClaude) {
    delete b.thinking;
  }

  return b;
}

function debugLog(label: string, data: any) {
  const line = `[${new Date().toISOString()}] ${label}\n${JSON.stringify(data, null, 2)}\n\n`;
  console.error(`[debug] ${label}:`, JSON.stringify(data).slice(0, 500));
  try {
    appendFileSync(DEBUG_LOG, line);
  } catch (e) {
    console.error("[debug] log write failed:", e);
  }
}

// ── 代理服务器 ────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // /pool/status → 凭证池状态
    if (path === "/pool/status") {
      return Response.json({
        total: pool.count,
        available: pool.availableCount,
        credsDir: CREDS_DIR,
      });
    }

    // /pool/reload → 热刷新凭证
    if (path === "/pool/reload") {
      pool.reload();
      return Response.json({
        total: pool.count,
        available: pool.availableCount,
        message: "reloaded",
      });
    }

    // /v1/models → 透传 keelcode 模型列表
    if (path === "/v1/models" || path === "/models") {
      const acct = pool.pick();
      if (!acct) {
        return Response.json({ error: "no available credentials" }, { status: 503 });
      }
      const r = await fetch(`${UPSTREAM}/v1/models`, {
        headers: { authorization: `Bearer ${acct.accessToken}` },
      });
      return new Response(r.body, {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }

    // /v1/messages → 核心代理
    if (path === "/v1/messages" || path === "/messages") {
      // 读取并转换 body
      let rawBody: any;
      let body: any;
      try {
        rawBody = await req.json();
        debugLog("RAW REQUEST", rawBody);
        body = normalizeBody(rawBody);
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }

      console.error(
        `[proxy] ${body.model} | ${body.messages?.length ?? 0} msgs | stream=${body.stream}`
      );
      debugLog("REQUEST", body);

      // 带轮换重试的请求
      const MAX_RETRIES = pool.count; // 每个账号试一次
      let lastErrStatus = 0;
      let lastErrBody = "";

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const acct = pool.pick();
        if (!acct) {
          console.error("[proxy] no available credentials for retry");
          break;
        }

        console.error(`[proxy] attempt ${attempt + 1} using account "${acct.label}"`);

        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "text/event-stream",
          "anthropic-version":
            req.headers.get("anthropic-version") || "2023-06-01",
          authorization: `Bearer ${acct.accessToken}`,
        };

        const upstream = await fetch(`${UPSTREAM}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        // 401 → 标记坏号，换下一个
        if (upstream.status === 401) {
          pool.markBad(acct.label);
          lastErrStatus = 401;
          lastErrBody = await upstream.text();
          console.error(`[proxy] 401 on ${acct.label}, rotating...`);
          continue;
        }

        // 429 → 冷却，换下一个
        if (upstream.status === 429) {
          pool.cooldown(acct.label);
          lastErrStatus = 429;
          lastErrBody = await upstream.text();
          console.error(`[proxy] 429 on ${acct.label}, cooling down, rotating...`);
          continue;
        }

        // 非 200 → 记录上游错误详情
        if (upstream.status >= 400) {
          const errText = await upstream.text();
          debugLog(`UPSTREAM ERROR ${upstream.status}`, JSON.parse(errText || "{}"));
          console.error(`[proxy] upstream ${upstream.status}:`, errText.slice(0, 300));
          return new Response(errText, {
            status: upstream.status,
            headers: { "content-type": "application/json" },
          });
        }

        // 成功 → 透传响应（SSE stream 或 JSON）
        const ct = upstream.headers.get("content-type") || "";
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            "content-type": ct,
            "cache-control": "no-cache",
            ...(ct.includes("text/event-stream")
              ? { connection: "keep-alive" }
              : {}),
          },
        });
      }

      // 所有账号都试过了
      if (lastErrStatus) {
        return new Response(lastErrBody, {
          status: lastErrStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ error: "no available credentials" }, { status: 503 });
    }

    // 其他路径 → 404
    return Response.json(
      { error: `unknown path: ${path}` },
      { status: 404 }
    );
  },
});

console.error(`[keelcode-proxy] listening on http://localhost:${PORT}`);
console.error(`[keelcode-proxy] upstream: ${UPSTREAM}`);
console.error(`[keelcode-proxy] creds dir: ${CREDS_DIR}`);
console.error(`[keelcode-proxy] pool: ${pool.count} account(s), ${pool.availableCount} available`);
console.error(`[keelcode-proxy] model map:`, MODEL_MAP);
console.error("");
console.error("Claude Code 配置:");
console.error(`  set ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
console.error("  set ANTHROPIC_API_KEY=keelcode");
console.error("");
console.error("多账号用法:");
console.error(`  把各账号的 credentials.json 放到 ${CREDS_DIR}/`);
console.error("  文件名即账号名: account1.json, account2.json, ...");
console.error("  默认 ~/.keelcode/credentials.json 自动作为 fallback");
console.error(`  查看状态: curl http://localhost:${PORT}/pool/status`);
console.error(`  热刷新:   curl http://localhost:${PORT}/pool/reload`);
