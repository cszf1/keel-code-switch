// keelcode-proxy: Anthropic 兼容本地桥 + 本机网页管理 UI
// 用法: bun run proxy.ts [--port 8082]
// UI:   http://127.0.0.1:8082/

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || "8082");
const UPSTREAM = "https://api.keelcode.ai";
const SCRIPT_DIR = import.meta.dir;
const PUBLIC_DIR = join(SCRIPT_DIR, "public");
const DEBUG_LOG = join(SCRIPT_DIR, "proxy-debug.log");
const CREDS_DIR =
  process.argv.find((_, i, a) => a[i - 1] === "--creds-dir") || join(SCRIPT_DIR, "credentials");
const UPSTREAM_UA = "keelcode-cli"; // Cloudflare 对无 UA 请求会 1010

interface Account {
  file: string;
  label: string;
  accessToken: string;
  expiresAt: string;
  disabled?: boolean;
  readonly?: boolean;
  bad?: boolean;
  cooldownUntil?: number;
  user?: string;
}

function safeLabel(label: string): string {
  const s = label.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(s)) {
    throw new Error("账号名仅允许字母数字 _ -，最长 64");
  }
  return s;
}

function tokenPreview(tok: string): string {
  if (!tok) return "";
  if (tok.length <= 16) return tok.slice(0, 4) + "…";
  return tok.slice(0, 10) + "…" + tok.slice(-6);
}

/** 邮箱匿名：ab***@g***.com */
function maskEmail(email: string | undefined | null): string | null {
  if (!email || typeof email !== "string") return null;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localMask =
    local.length <= 1 ? "*" : local.length === 2 ? local[0] + "*" : local[0] + "***" + local[local.length - 1];
  const dots = domain.split(".");
  const name = dots[0] || "";
  const nameMask = name.length <= 1 ? "*" : name[0] + "***";
  const tld = dots.slice(1).join(".");
  return `${localMask}@${nameMask}${tld ? "." + tld : ""}`;
}

function displayUser(userField: any): string | null {
  if (!userField) return null;
  if (typeof userField === "string") {
    return userField.includes("@") ? maskEmail(userField) : userField;
  }
  if (typeof userField === "object") {
    const email = maskEmail(userField.email);
    const name = userField.name || userField.id || null;
    if (email && name) return `${name} · ${email}`;
    return email || name;
  }
  return null;
}

class CredentialPool {
  private accounts: Account[] = [];
  private idx = 0;

  load() {
    const prev = new Map(this.accounts.map((a) => [a.label, a]));
    this.accounts = [];

    if (!existsSync(CREDS_DIR)) mkdirSync(CREDS_DIR, { recursive: true });

    const files = readdirSync(CREDS_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    for (const f of files) {
      const fp = join(CREDS_DIR, f);
      try {
        const cred = JSON.parse(readFileSync(fp, "utf-8"));
        if (!cred.accessToken) continue;
        const label = f.replace(/\.json$/, "");
        const old = prev.get(label);
        this.accounts.push({
          file: fp,
          label,
          accessToken: cred.accessToken,
          expiresAt: cred.expiresAt || "",
          disabled: !!cred.disabled,
          user: displayUser(cred.user) || undefined,
          bad: old?.bad,
          cooldownUntil: old?.cooldownUntil,
        });
      } catch {
        console.error(`[pool] failed to parse ${f}`);
      }
    }

    // fallback: ~/.keelcode/credentials.json（只读，不在目录里时挂上）
    const defaultPath = join(homedir(), ".keelcode", "credentials.json");
    if (existsSync(defaultPath)) {
      try {
        const cred = JSON.parse(readFileSync(defaultPath, "utf-8"));
        if (
          cred.accessToken &&
          !this.accounts.some((a) => a.accessToken === cred.accessToken)
        ) {
          const label = "home-default";
          const old = prev.get(label);
          this.accounts.push({
            file: defaultPath,
            label,
            accessToken: cred.accessToken,
            expiresAt: cred.expiresAt || "",
            disabled: !!cred.disabled,
            readonly: true,
            user: displayUser(cred.user) || undefined,
            bad: old?.bad,
            cooldownUntil: old?.cooldownUntil,
          });
        }
      } catch {}
    }

    if (this.accounts.length === 0) {
      console.error(`[pool] no credentials in ${CREDS_DIR} (UI 仍可添加账号)`);
    } else {
      console.error(`[pool] loaded ${this.accounts.length} account(s):`);
      for (const a of this.accounts) {
        const exp = a.expiresAt ? new Date(a.expiresAt) : null;
        const valid = !exp || exp > new Date();
        console.error(
          `  ${a.label}: ${a.disabled ? "disabled" : valid ? "valid" : "EXPIRED"} (${a.file})`,
        );
      }
    }
  }

  list() {
    const now = Date.now();
    return this.accounts.map((a) => {
      const expired = !!(a.expiresAt && new Date(a.expiresAt) <= new Date());
      const cooldownRemainingMs =
        a.cooldownUntil && a.cooldownUntil > now ? a.cooldownUntil - now : 0;
      const ready =
        !a.disabled && !a.bad && !expired && cooldownRemainingMs <= 0;
      return {
        label: a.label,
        expiresAt: a.expiresAt || null,
        disabled: !!a.disabled,
        bad: !!a.bad,
        expired,
        cooldownRemainingMs,
        ready,
        readonly: !!a.readonly,
        tokenPreview: tokenPreview(a.accessToken),
        user: a.user || null,
        source: a.readonly ? "home" : "credentials",
        file: a.file,
      };
    });
  }

  pick(): Account | null {
    const n = this.accounts.length;
    if (!n) return null;
    for (let i = 0; i < n; i++) {
      const a = this.accounts[this.idx % n];
      this.idx++;
      if (a.disabled) continue;
      if (a.bad) continue;
      if (a.cooldownUntil && Date.now() < a.cooldownUntil) continue;
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
    return null;
  }

  markBad(label: string) {
    const a = this.accounts.find((x) => x.label === label);
    if (a) {
      a.bad = true;
      console.error(`[pool] ${label} marked BAD (401)`);
    }
  }

  cooldown(label: string, ms = 60000) {
    const a = this.accounts.find((x) => x.label === label);
    if (a) {
      a.cooldownUntil = Date.now() + ms;
      console.error(`[pool] ${label} cooling down ${ms / 1000}s (429)`);
    }
  }

  reset(label: string) {
    const a = this.accounts.find((x) => x.label === label);
    if (!a) throw new Error("账号不存在");
    a.bad = false;
    a.cooldownUntil = undefined;
  }

  reload() {
    this.load();
  }

  upsert(labelRaw: string, data: { accessToken: string; expiresAt?: string; disabled?: boolean; [k: string]: any }) {
    const label = safeLabel(labelRaw);
    if (!data.accessToken || typeof data.accessToken !== "string") {
      throw new Error("缺少 accessToken");
    }
    const fp = join(CREDS_DIR, `${label}.json`);
    let existing: any = {};
    if (existsSync(fp)) {
      try {
        existing = JSON.parse(readFileSync(fp, "utf-8"));
      } catch {}
    }
    const out = {
      ...existing,
      ...data,
      accessToken: data.accessToken,
      expiresAt: data.expiresAt ?? existing.expiresAt ?? "",
      disabled: data.disabled ?? existing.disabled ?? false,
    };
    if (!existsSync(CREDS_DIR)) mkdirSync(CREDS_DIR, { recursive: true });
    writeFileSync(fp, JSON.stringify(out, null, 2) + "\n", "utf-8");
    this.load();
    return label;
  }

  setDisabled(label: string, disabled: boolean) {
    const a = this.accounts.find((x) => x.label === label);
    if (!a) throw new Error("账号不存在");
    if (a.readonly) {
      // home fallback：只改内存禁用，不写文件
      a.disabled = disabled;
      return;
    }
    const raw = JSON.parse(readFileSync(a.file, "utf-8"));
    raw.disabled = disabled;
    writeFileSync(a.file, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    this.load();
  }

  remove(label: string) {
    const a = this.accounts.find((x) => x.label === label);
    if (!a) throw new Error("账号不存在");
    if (a.readonly) throw new Error("系统 fallback 账号不可删除，可禁用");
    if (!a.file.startsWith(CREDS_DIR)) throw new Error("拒绝删除目录外文件");
    unlinkSync(a.file);
    this.load();
  }

  importHome(labelRaw?: string) {
    const defaultPath = join(homedir(), ".keelcode", "credentials.json");
    if (!existsSync(defaultPath)) throw new Error("未找到 ~/.keelcode/credentials.json，请先 keelcode login");
    const cred = JSON.parse(readFileSync(defaultPath, "utf-8"));
    if (!cred.accessToken) throw new Error("home credentials 无 accessToken");
    const label = safeLabel(labelRaw || "default");
    return this.upsert(label, cred);
  }

  get count() {
    return this.accounts.length;
  }
  get availableCount() {
    return this.list().filter((a) => a.ready).length;
  }

  /** 给额度查询用：返回含 token 的账号快照 */
  rawAccounts(): Account[] {
    return this.accounts.slice();
  }
}

async function fetchAccountUsage(acct: Account): Promise<any> {
  try {
    const r = await fetch(`${UPSTREAM}/api/v1/usage`, {
      headers: {
        authorization: `Bearer ${acct.accessToken}`,
        accept: "application/json",
        "user-agent": UPSTREAM_UA,
      },
    });
    const text = await r.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    if (!r.ok) {
      return {
        ok: false,
        status: r.status,
        error: data?.detail || data?.title || data?.error || text.slice(0, 160),
      };
    }
    return {
      ok: true,
      plan: data.plan,
      request_count: data.request_count,
      input_tokens: data.input_tokens,
      output_tokens: data.output_tokens,
      credits_spent: data.credits_spent,
      period: data.period,
      pools: (data.pools || []).map((p: any) => ({
        id: p.id,
        label: p.label,
        remaining_usd: p.remaining_usd,
        limit_usd: p.limit_usd,
        used_usd: p.used_usd,
        remaining: p.remaining,
        limit: p.limit,
        used: p.used,
      })),
      entitlement: data.entitlement || null,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function enrichAccountsWithUsage() {
  const base = pool.list();
  const raw = pool.rawAccounts();
  const byLabel = new Map(raw.map((a) => [a.label, a]));
  const out = [];
  for (const row of base) {
    const acct = byLabel.get(row.label);
    if (!acct || row.disabled || row.expired) {
      out.push({ ...row, usage: null });
      continue;
    }
    const usage = await fetchAccountUsage(acct);
    out.push({ ...row, usage });
  }
  return out;
}

const pool = new CredentialPool();
pool.load();

const MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "claude-opus-4-20250514": "claude-opus-4-8",
  "claude-sonnet-5-20250514": "claude-sonnet-5",
  "claude-haiku-4-20250514": "haiku-4",
  "claude-3-5-haiku-20241022": "haiku-4",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4-6",
};

function mapModel(model: string): string {
  // Claude Code / CC Switch 常带 [1M] 后缀
  let m = model.replace(/\[1m\]/i, "").trim();
  if (MODEL_MAP[m]) return MODEL_MAP[m];
  for (const [pattern, target] of Object.entries(MODEL_MAP)) {
    const prefix = pattern.replace(/-\d{8}$/, "");
    if (m.startsWith(prefix)) return target;
  }
  return m;
}

function normalizeContent(content: unknown): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

/** keel 不认的键：递归剥离 */
const STRIP_KEYS = new Set([
  "cache_control",
  "defer_loading",
  "$schema",
  "anthropic_beta",
  "caller",
]);

function scrub(obj: any): any {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(scrub);
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_KEYS.has(k)) continue;
    out[k] = scrub(v);
  }
  return out;
}

function sanitizeTools(tools: any[]): any[] {
  const out: any[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    // 跳过占位/延迟加载工具
    if (raw.defer_loading) continue;
    if (raw.name === "DeferredToolPlaceholder") continue;

    const tool: any = scrub(raw);
    // 只保留 Anthropic tool 标准字段
    const clean: any = {
      name: tool.name,
      description:
        typeof tool.description === "string"
          ? tool.description.slice(0, 12000)
          : tool.description || "",
      input_schema: tool.input_schema || { type: "object", properties: {} },
    };
    if (clean.input_schema && typeof clean.input_schema === "object") {
      // 强制基础 object schema
      if (!clean.input_schema.type) clean.input_schema.type = "object";
      if (!clean.input_schema.properties) clean.input_schema.properties = {};
      // 补缺 type
      for (const prop of Object.values(clean.input_schema.properties) as any[]) {
        if (prop && typeof prop === "object" && !("type" in prop) && !prop.anyOf && !prop.oneOf) {
          prop.type = "string";
        }
      }
    }
    if (!clean.name) continue;
    out.push(clean);
  }
  return out;
}

function normalizeBody(body: any): any {
  const b = { ...body };
  if (b.model) b.model = mapModel(b.model);
  b.stream = true;

  const MAX_TOKENS_CAP: Record<string, number> = {
    "kimi-k3": 12000,
    "deepseek-v4-pro": 12000,
    "deepseek-v4-flash": 12000,
    "glm-5.2": 12000,
    "haiku-4": 8192,
    "claude-sonnet-4-6": 16384,
    "claude-sonnet-5": 16384,
    "claude-opus-4-8": 16384,
    "claude-fable-5": 16384,
  };
  const cap = MAX_TOKENS_CAP[b.model] ?? 16384;
  if (typeof b.max_tokens === "number" && b.max_tokens > cap) b.max_tokens = cap;

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
      .map((m: any) => {
        const msg: any = {
          role: m.role,
          content: scrub(normalizeContent(m.content)),
        };
        // tool 结果
        if (m.tool_use_id) msg.tool_use_id = m.tool_use_id;
        if (m.name && m.role === "tool") msg.name = m.name;
        return msg;
      });
    if (systemMsgs.length > 0) {
      const extra = systemMsgs.flatMap((m) =>
        Array.isArray(m.content)
          ? scrub(m.content)
          : [{ type: "text", text: String(m.content ?? "") }],
      );
      b.system = [...(Array.isArray(b.system) ? b.system : []), ...extra];
    }
  }

  if (typeof b.system === "string") {
    b.system = [{ type: "text", text: b.system }];
  } else if (Array.isArray(b.system)) {
    b.system = scrub(b.system).map((block: any) => {
      if (block && typeof block === "object" && block.type === "text") {
        return { type: "text", text: String(block.text ?? "") };
      }
      return block;
    });
  }

  if (Array.isArray(b.tools)) {
    b.tools = sanitizeTools(b.tools);
    if (b.tools.length === 0) delete b.tools;
  }

  // Claude Code 新版 thinking.type=adaptive 等 keel 不认 → 直接去掉
  // （否则整请求 400 invalid_request）
  if (b.thinking) {
    const t = b.thinking;
    const ok =
      t &&
      typeof t === "object" &&
      (t.type === "enabled" || t.type === "disabled") &&
      (t.type !== "enabled" || typeof t.budget_tokens === "number");
    if (!ok) delete b.thinking;
    if (t?.type === "disabled") delete b.thinking;
  }
  // 非 Claude 模型一律不带 thinking
  if (b.thinking && !/^claude/.test(b.model || "")) delete b.thinking;

  delete b.metadata;
  delete b.service_tier;
  delete b.mcp_servers;
  delete b.context_management;
  delete b.output_config;
  delete b.container;
  delete b.speed;
  delete b.inference_geo;

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

function json(data: any, status = 200) {
  return Response.json(data, { status });
}

function readLogTail(lines = 80): string {
  if (!existsSync(DEBUG_LOG)) return "";
  const text = readFileSync(DEBUG_LOG, "utf-8");
  const arr = text.split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}

async function handleApi(req: Request, path: string, url: URL): Promise<Response | null> {
  if (path === "/api/status" && req.method === "GET") {
    const withUsage = url.searchParams.get("usage") !== "0";
    const accounts = withUsage ? await enrichAccountsWithUsage() : pool.list();
    return json({
      total: pool.count,
      available: pool.availableCount,
      upstream: UPSTREAM,
      credsDir: CREDS_DIR,
      listen: `http://127.0.0.1:${PORT}`,
      port: PORT,
      accounts,
    });
  }

  if (path === "/api/usage" && req.method === "GET") {
    const accounts = await enrichAccountsWithUsage();
    return json({ accounts });
  }

  if (path === "/api/pool/reload" && req.method === "POST") {
    pool.reload();
    return json({ total: pool.count, available: pool.availableCount, message: "reloaded" });
  }
  // 兼容旧端点
  if (path === "/pool/reload") {
    pool.reload();
    return json({ total: pool.count, available: pool.availableCount, message: "reloaded" });
  }
  if (path === "/pool/status") {
    return json({ total: pool.count, available: pool.availableCount, credsDir: CREDS_DIR });
  }

  if (path === "/api/accounts" && req.method === "GET") {
    return json({ accounts: pool.list() });
  }

  if (path === "/api/accounts" && req.method === "POST") {
    try {
      const body = await req.json();
      const label = pool.upsert(body.label, body);
      return json({ ok: true, label, accounts: pool.list() });
    } catch (e: any) {
      return json({ error: e.message || String(e) }, 400);
    }
  }

  if (path === "/api/accounts/import-home" && req.method === "POST") {
    try {
      const body = await req.json().catch(() => ({}));
      const label = pool.importHome(body.label);
      return json({ ok: true, label, accounts: pool.list() });
    } catch (e: any) {
      return json({ error: e.message || String(e) }, 400);
    }
  }

  const accMatch = path.match(/^\/api\/accounts\/([^/]+)(\/reset)?$/);
  if (accMatch) {
    const label = decodeURIComponent(accMatch[1]);
    const isReset = !!accMatch[2];
    try {
      if (isReset && req.method === "POST") {
        pool.reset(label);
        return json({ ok: true, accounts: pool.list() });
      }
      if (req.method === "DELETE") {
        pool.remove(label);
        return json({ ok: true, accounts: pool.list() });
      }
      if (req.method === "PATCH") {
        const body = await req.json();
        if (typeof body.disabled === "boolean") pool.setDisabled(label, body.disabled);
        if (body.accessToken) {
          pool.upsert(label, {
            accessToken: body.accessToken,
            expiresAt: body.expiresAt,
            disabled: body.disabled,
          });
        }
        return json({ ok: true, accounts: pool.list() });
      }
    } catch (e: any) {
      return json({ error: e.message || String(e) }, 400);
    }
  }

  if (path === "/api/models" && req.method === "GET") {
    const acct = pool.pick();
    if (!acct) return json({ error: "no available credentials", data: [] }, 503);
    const r = await fetch(`${UPSTREAM}/v1/models`, {
      headers: {
        authorization: `Bearer ${acct.accessToken}`,
        "user-agent": UPSTREAM_UA,
        accept: "application/json",
      },
    });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (path === "/api/logs" && req.method === "GET") {
    const n = parseInt(url.searchParams.get("lines") || "80");
    return json({ text: readLogTail(Number.isFinite(n) ? n : 80) });
  }

  return null;
}

function servePublic(pathName: string): Response | null {
  let rel = pathName === "/" ? "/index.html" : pathName;
  if (rel === "/ui" || rel === "/ui/") rel = "/index.html";
  if (rel.includes("..")) return json({ error: "bad path" }, 400);
  const fp = join(PUBLIC_DIR, rel.replace(/^\//, ""));
  if (!fp.startsWith(PUBLIC_DIR)) return json({ error: "bad path" }, 400);
  if (!existsSync(fp)) return null;
  const file = Bun.file(fp);
  return new Response(file);
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
    }

    // 管理 API
    if (path.startsWith("/api/") || path === "/pool/status" || path === "/pool/reload") {
      const apiResp = await handleApi(req, path, url);
      if (apiResp) return apiResp;
    }

    // 静态 UI
    if (req.method === "GET") {
      const page = servePublic(path);
      if (page) return page;
    }

    // /v1/models
    if (path === "/v1/models" || path === "/models") {
      const acct = pool.pick();
      if (!acct) return json({ error: "no available credentials" }, 503);
      const r = await fetch(`${UPSTREAM}/v1/models`, {
        headers: {
          authorization: `Bearer ${acct.accessToken}`,
          "user-agent": UPSTREAM_UA,
          accept: "application/json",
        },
      });
      return new Response(r.body, {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }

    // /v1/messages
    if (path === "/v1/messages" || path === "/messages") {
      let rawBody: any;
      let body: any;
      try {
        rawBody = await req.json();
        debugLog("RAW REQUEST", rawBody);
        body = normalizeBody(rawBody);
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }

      console.error(
        `[proxy] ${body.model} | ${body.messages?.length ?? 0} msgs | stream=${body.stream}`,
      );
      debugLog("REQUEST", body);

      const MAX_RETRIES = Math.max(pool.count, 1);
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
          "anthropic-version": req.headers.get("anthropic-version") || "2023-06-01",
          authorization: `Bearer ${acct.accessToken}`,
          "user-agent": UPSTREAM_UA,
        };

        const upstream = await fetch(`${UPSTREAM}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (upstream.status === 401) {
          pool.markBad(acct.label);
          lastErrStatus = 401;
          lastErrBody = await upstream.text();
          console.error(`[proxy] 401 on ${acct.label}, rotating...`);
          continue;
        }

        if (upstream.status === 429) {
          pool.cooldown(acct.label);
          lastErrStatus = 429;
          lastErrBody = await upstream.text();
          console.error(`[proxy] 429 on ${acct.label}, cooling down, rotating...`);
          continue;
        }

        if (upstream.status >= 400) {
          const errText = await upstream.text();
          try {
            debugLog(`UPSTREAM ERROR ${upstream.status}`, JSON.parse(errText || "{}"));
          } catch {
            debugLog(`UPSTREAM ERROR ${upstream.status}`, errText);
          }
          console.error(`[proxy] upstream ${upstream.status}:`, errText.slice(0, 300));
          return new Response(errText, {
            status: upstream.status,
            headers: { "content-type": "application/json" },
          });
        }

        const ct = upstream.headers.get("content-type") || "";
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            "content-type": ct,
            "cache-control": "no-cache",
            ...(ct.includes("text/event-stream") ? { connection: "keep-alive" } : {}),
          },
        });
      }

      if (lastErrStatus) {
        return new Response(lastErrBody, {
          status: lastErrStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return json({ error: "no available credentials" }, 503);
    }

    return json({ error: `unknown path: ${path}` }, 404);
  },
});

console.error(`[keelcode-proxy] UI      http://127.0.0.1:${PORT}/`);
console.error(`[keelcode-proxy] API     http://127.0.0.1:${PORT}/v1/messages`);
console.error(`[keelcode-proxy] upstream ${UPSTREAM}`);
console.error(`[keelcode-proxy] creds   ${CREDS_DIR}`);
console.error(
  `[keelcode-proxy] pool    ${pool.count} account(s), ${pool.availableCount} available`,
);
