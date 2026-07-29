# keelcode-proxy

本地代理，让 Claude Code 等标准 Anthropic 客户端直接走 keelcode 托管 API，支持多账号轮换。

## 为什么需要

keelcode 的 API (`api.keelcode.ai`) 兼容 Anthropic Messages 协议，但有几处差异导致 Claude Code 无法直连：

- 认证方式：keelcode 要 `Authorization: Bearer`，Claude Code 发 `x-api-key`
- content 格式：keelcode 要数组 `[{type:"text",text:"..."}]`，Claude Code 发字符串
- 模型名：keelcode 用自定义名（`kimi-k3`、`deepseek-v4-pro`），Claude Code 发标准 Anthropic 名
- stream：keelcode 只支持 `stream:true`
- max_tokens：各模型有不同上限，Claude Code 默认发 32000
- 部分字段：`cache_control`、`metadata`、`context_management`、`output_config`、`anthropic-beta` header 等被 keelcode 拒绝
- tool description 长度限制 ~16000 字符（Claude Code 的 Workflow tool 有 19285 字符）

代理自动处理这些差异，让 Claude Code 无缝接入 keelcode。

## 依赖

- [Bun](https://bun.sh) 1.0+
- keelcode CLI（已登录至少一个账号）

## 快速开始

### 1. 启动代理

```bash
cd E:\otherproject\keelcode
bun run proxy.ts
```

默认监听 `http://localhost:8082`，自动加载 `~/.keelcode/credentials.json`。

### 2. 配置 Claude Code

```cmd
set ANTHROPIC_BASE_URL=http://localhost:8082
set ANTHROPIC_API_KEY=keelcode
claude --model kimi-k3
```

`--model` 可用值：`kimi-k3`、`deepseek-v4-pro`、`deepseek-v4-flash`、`glm-5.2`、`claude-sonnet-4-6`、`claude-opus-4-8`、`claude-sonnet-5`、`claude-fable-5`、`haiku-4` 等。也支持标准 Anthropic 模型名，代理自动映射。

## 多账号轮换

把多个 keelcode 账号的凭证文件放到 `credentials/` 目录，代理自动 round-robin 轮换：

```
credentials/
  account1.json
  account2.json
  work.json
```

每个文件格式与 keelcode 原生的 `credentials.json` 一致：

```json
{
  "accessToken": "ey...",
  "expiresAt": "2026-08-01T12:00:00.000Z"
}
```

轮换策略：

- 每次请求 round-robin 切换账号
- 401（认证失败）→ 标记坏号，自动跳过，换下一个
- 429（限流）→ 冷却 60 秒，换下一个
- token 过期 → 自动跳过
- `~/.keelcode/credentials.json` 始终作为 fallback（去重）

### 添加新账号

```bash
python add-account.py work
```

脚本会执行 `keelcode login`（浏览器 OAuth），完成后自动复制凭证到 `credentials/work.json` 并热刷新代理，无需重启。

### 管理端点

```bash
# 查看凭证池状态
curl http://localhost:8082/pool/status

# 热刷新（加了新凭证文件后执行）
curl http://localhost:8082/pool/reload
```

## 代理做了什么

每个请求经过以下转换：

| 项目 | Claude Code 发的 | 代理转换后 |
|---|---|---|
| 认证 | `x-api-key: xxx` | `Authorization: Bearer <token>` |
| content | 字符串 `"hi"` | 数组 `[{type:"text",text:"hi"}]` |
| 模型名 | `claude-sonnet-4-20250514` | `claude-sonnet-4-6` |
| stream | `false` 或 `true` | 强制 `true` |
| max_tokens | `32000` | 按模型限制（kimi-k3→12000） |
| role:"system" 消息 | 在 messages 数组里 | 合并到顶层 system 字段 |
| tool description | 可能超 16000 字符 | 截断到 16000 |
| tool property 缺 type | `{"description":"..."}` | 补 `type:"string"` |

同时递归剥离这些字段：
`cache_control`、`metadata`、`service_tier`、`mcp_servers`、`context_management`、`output_config`、`anthropic-beta` header、非 Claude 模型的 `thinking`。

## 启动参数

```
bun run proxy.ts [--port 8082] [--creds-dir <path>]
```

- `--port`：监听端口，默认 8082
- `--creds-dir`：凭证目录，默认 `E:\otherproject\keelcode\credentials`

## 文件说明

```
keelcode/
├── proxy.ts              代理主程序
├── add-account.py        多账号快速登录脚本
├── credentials/          凭证目录（每个 .json 一个账号）
├── proxy-debug.log       请求/错误日志（调试用）
└── proxy-stderr.log      代理运行日志
```

## 调试

代理运行日志输出到 stderr（终端或 `proxy-stderr.log`），请求/响应详情写入 `proxy-debug.log`。遇到问题时先看这两个文件。

常见问题：

- **400 invalid_request**：检查 `proxy-debug.log` 里的 REQUEST 部分，看是否有未处理的字段
- **503 provider_unavailable**：模型暂时不可用，重试或换模型
- **401**：token 过期，用 `python add-account.py` 重新登录
- **代理不启动 EADDRINUSE**：端口被占，`netstat -aon | grep 8082` 找 PID 后 `taskkill //F //PID <pid>`
