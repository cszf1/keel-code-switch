# keelcode-proxy

本地 Anthropic 兼容代理：让 Claude Code / 其它标准 Anthropic 客户端走 [keelcode](https://api.keelcode.ai) 托管 API，支持多账号轮换与网页管理。

## 为什么需要

keelcode API 兼容 Anthropic Messages，但和 Claude Code 直连仍有差异：

- 认证：keelcode 要 `Authorization: Bearer`，客户端常发 `x-api-key`
- content：keelcode 要 `[{type:"text",text}]`，客户端可能发字符串
- 模型名：keelcode 自定义名（`kimi-k3`、`deepseek-v4-pro` 等）
- stream：keelcode 只支持 `stream:true`
- max_tokens：各模型上限不同
- 部分字段会被拒绝：`cache_control`、`thinking.type=adaptive`、tool 的 `$schema` / `defer_loading` 等
- tool description 过长会被拒

本代理自动做协议适配与字段清洗。

## 依赖

- [Bun](https://bun.sh) 1.0+
- 可选：[keelcode CLI](https://www.npmjs.com/package/@keelcode-ai/keelcode)（`keelcode login` 拿凭证）

## 快速开始

```bash
# 安装 Bun 后
bun run proxy.ts
# 或指定端口
bun run proxy.ts --port 8082
```

Windows 后台启动：

```powershell
.\start-hidden.ps1
```

默认监听：`http://127.0.0.1:8082`（仅本机）

### 网页管理

浏览器打开：<http://127.0.0.1:8082/>

- **网页 OAuth 登录**（device code，**无需安装 keelcode CLI**）
- 账号池状态 / 启用禁用 / 删除 / 重置 / 日额度
- 粘贴 token 或完整 JSON 添加账号
- 导入 `~/.keelcode/credentials.json`（若本机曾用过 CLI）
- 热加载、模型列表、调试日志

### 配置客户端（示例）

任意 Anthropic Messages 兼容客户端：

```text
Base URL:  http://127.0.0.1:8082
API Key:   任意非空字符串（真实 token 在账号池）
```

Claude Code 环境变量示例：

```cmd
set ANTHROPIC_BASE_URL=http://127.0.0.1:8082
set ANTHROPIC_API_KEY=keelcode
```

常用模型：`kimi-k3`、`deepseek-v4-pro`、`deepseek-v4-flash`、`glm-5.2` 等。也支持部分标准 Anthropic 名，代理会映射。

> Free 额度下 Open models 通常更稳；Claude / GPT 可能出现 `provider_unavailable`。

## 多账号

把多个凭证放到 `credentials/`：

```text
credentials/
  account1.json
  account2.json
```

格式与 keelcode 原生 `~/.keelcode/credentials.json` 一致：

```json
{
  "accessToken": "…",
  "expiresAt": "2026-08-01T12:00:00.000Z"
}
```

轮换策略：

- 请求级 round-robin
- 401 → 标坏并跳过
- 429 → 冷却 60s 后换号
- 过期 / disabled → 跳过
- `~/.keelcode/credentials.json` 可作为 fallback（token 去重）

添加账号：

```bash
python add-account.py work
```

或在网页 UI 里粘贴 / 导入。

## 管理 API

```bash
curl http://127.0.0.1:8082/api/status
curl -X POST http://127.0.0.1:8082/api/pool/reload
curl http://127.0.0.1:8082/api/models
```

兼容旧路径：`/pool/status`、`/pool/reload`。

## 启动参数

```text
bun run proxy.ts [--port 8082] [--creds-dir <path>]
```

- `--port` 默认 `8082`
- `--creds-dir` 默认 `./credentials`

## 目录结构

```text
.
├── proxy.ts           # 代理 + 管理 API
├── public/index.html  # 管理 UI
├── add-account.py     # CLI 加号
├── start.ps1          # 前台启动
├── start-hidden.ps1   # 后台启动
└── credentials/       # 本地凭证（勿提交）
```

## 安全

- 默认只绑定 `127.0.0.1`
- **不要**把 `credentials/*.json`、日志提交到 Git
- Token / 邮箱等敏感信息不会出现在公开 README；UI 对邮箱做匿名显示

## 调试

- 运行日志：stderr 或 `logs/`
- 请求详情：`proxy-debug.log`（本地，已 gitignore）

常见问题：

| 现象 | 处理 |
|------|------|
| 400 `invalid_request` | 看 debug 日志；代理会清洗 adaptive thinking / `$schema` 等 |
| 503 `provider_unavailable` | 换 Open 模型或稍后重试 |
| 401 | token 过期，重新 `keelcode login` 并导入 |
| EADDRINUSE | 端口被占，结束占用进程或换 `--port` |

## License

以原仓库为准。本仓库为协议适配与本地管理增强。
