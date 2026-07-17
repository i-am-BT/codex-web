# Codex Web

一个轻量级的 Codex Web 界面，用来在浏览器中直接运行和管理 Codex App 原生任务与会话。

## 安全提醒

本项目完全由 AI 制作，未经过正式安全审计。部署、公开访问或处理敏感数据前，请自行检查代码、依赖、配置、鉴权逻辑和运行环境安全。

## 功能

- 在浏览器里创建、切换和继续 Codex App 原生会话
- 通过持久 `codex app-server` 实现 Web 与 Codex App 双向同步
- 只显示 Codex App 中未归档的普通用户会话，不显示自动化任务
- 最近会话按工作目录分组，显示项目名与完整路径
- 支持会话改名、归档和历史记录管理
- 支持从历史用户消息创建原生会话分支，恢复原消息后修改并重新发送
- 支持流式显示助手回复与思考摘要；历史思考和工具调用默认折叠
- 每轮只保留最新一次工具调用，助手输出支持安全 Markdown
- 支持取消任务以及命令、文件、权限、用户输入和 MCP 请求确认
- 浏览器断开后，已启动的任务会继续在服务端运行
- 手机切换应用、页面恢复或 SSE 重连时会保留流式消息，并在完整历史落盘后安全同步
- 支持上传图片、PDF、文本和代码附件
- 支持管理模型服务商和默认模型
- 支持为已有服务商重新获取最新模型列表
- 支持选择并保存模型思考档位：默认、low、medium、high、xhigh
- 支持删除服务商，且会防止删除最后一个服务商
- 支持界面外观设置和自定义聊天背景
- 提供健康检查接口：`/api/health`

## 环境要求

- Node.js 22.5 或更高版本（原生会话索引依赖 `node:sqlite`）
- npm
- 运行主机已安装并配置可用的 Codex CLI；历史分支功能需要 0.144.4 或更高版本

## 安装

```bash
npm install
npm run setup
```

`npm run setup` 会生成仅监听 `127.0.0.1` 的 `.env`，自动发现 Codex CLI，并创建随机登录密码和会话密钥。也可以跳过该命令，手动复制并编辑 `.env.example`。

## 配置

项目会从项目目录的 `.env` 和 `CODEX_HOME` 下的 Codex 配置文件读取运行配置。

手动配置时，复制示例文件后再填写当前主机的配置：

```bash
cp .env.example .env
```

`.env.example` 只包含脱敏占位符，可以提交到仓库；真实 `.env` 不要提交。

如果是新设备首次运行，还需要准备 Codex 配置：

- `${CODEX_HOME:-$HOME/.codex}/.env`：保存服务商 API Key，可参考 `codex.env.example`
- `${CODEX_HOME:-$HOME/.codex}/config.toml`：保存服务商和模型配置，可参考 `codex.config.example.toml`

默认以只读方式使用主机 Codex 配置。只有显式设置 `CODEX_CONFIG_WRITABLE=true` 后，Web 中的服务商管理和默认设置写入功能才会显示。

主要环境变量：

| 变量 | 说明 |
| --- | --- |
| `CODEX_WEB_PASSWORD` | Web 登录密码，必填 |
| `SESSION_SECRET` | 登录会话签名密钥，建议设置为稳定的随机字符串 |
| `SESSION_TTL_HOURS` | 登录有效期，默认 168 小时 |
| `HOMEPAGE_API_TOKEN` | Homepage 统计接口访问令牌；未设置时接口禁用 |
| `HOMEPAGE_MODEL_CACHE_SECONDS` | Homepage 模型数量缓存秒数，默认 60 |
| `IMAGE_PROMPT_AUTO_SYNC` | 启动时及定时检查 `awesome-gpt-image-2` 更新，默认开启 |
| `IMAGE_PROMPT_SYNC_INTERVAL_MINUTES` | 提示词库自动检查间隔，默认 360 分钟 |
| `IMAGE_PROMPT_SYNC_TIMEOUT_MS` | 单次 GitHub 请求超时，默认 20000 毫秒 |
| `IMAGE_PROMPT_GITHUB_TOKEN` | 可选 GitHub Token，仅用于提高 API 速率限制 |
| `HOST` | 监听地址，默认 `127.0.0.1` |
| `PORT` | 固定监听端口，示例为 `36354` |
| `CODEX_BIN` | Codex CLI 路径；初始化脚本会优先发现 ChatGPT/Codex App 内置版本 |
| `CODEX_HOME` | Codex 配置、索引和原生会话目录，默认 `$HOME/.codex` |
| `APP_SERVER_REQUEST_TIMEOUT_MS` | `codex app-server` 单次协议请求超时，默认 30000 毫秒 |
| `CODEX_DESKTOP_IPC_ENABLED` | macOS/Windows 默认开启；续聊优先交给当前打开任务的 Codex App 窗口 |
| `CODEX_DESKTOP_IPC_TIMEOUT_MS` | Codex App 桌面 IPC 请求超时，默认 20000 毫秒 |
| `CODEX_DESKTOP_IPC_SOCKET` | 可选的桌面 IPC socket/pipe 覆盖路径，通常留空自动发现 |
| `NATIVE_SESSION_POLL_MS` | 原生会话文件监听的轮询兜底间隔 |
| `DEFAULT_PROVIDER` | 新会话默认服务商 |
| `DEFAULT_MODEL` | 新会话默认模型 |
| `DEFAULT_CWD` | 新会话默认工作目录 |
| `DEFAULT_SANDBOX` | Codex 默认沙箱模式 |
| `DEFAULT_APPROVAL` | Codex 默认审批模式 |

本仓库已默认忽略 `.env`、`runtime/` 和 `node_modules/`。请勿手动移除忽略规则或强制提交这些本地敏感/运行时文件。

Image Prompt 的案例和模板会保留仓库内置快照作为兜底。自动更新写入 `runtime/image-prompts/`，不会修改已跟踪的 `vendor/` 文件；GitHub 不可用或数据校验失败时继续使用最近一次成功版本。

仓库提供以下安全示例，不包含真实凭据或运行数据：

- `.env.example`：完整环境变量模板，所有敏感字段均为占位符
- `runtime.example/`：运行目录结构和脱敏 JSON 示例
- `node_modules.example/`：依赖目录重建说明；真实依赖请通过 `npm ci` 安装

## 启动

```bash
npm start
```

启动后访问：

```text
http://localhost:36354
```

如果 `.env` 中配置了其他端口，请使用对应端口访问。

## 模型与服务商

服务商配置保存在 `CODEX_HOME` 中，API Key 默认保存在 `$CODEX_HOME/.env`。Web 不会在仓库中保存真实密钥。

更新已有服务商的模型列表：

1. 打开 Web 设置。
2. 在 Provider 中选择服务商。
3. 点击“更新模型”。
4. 在 Model 下拉框中选择模型。
5. 如需修改默认值，点击“设为默认模型”。

模型列表来自服务商的 `<base_url>/models` 接口，Web 不会按模型名称过滤。如果上游支持直接调用某个模型但没有在 `/models` 中返回它，该模型不会自动出现在下拉框中。

思考档位：

1. 在设置中的 Reasoning 选择 `默认`、`low`、`medium`、`high`、`xhigh` 或 `max`。
2. 当前选择会随每次 Web 任务显式传给 Codex App。
3. 点击“设为默认模型”时，服务商、模型和思考档位会一起保存到本机 Codex 配置。
4. 选择“默认”表示不覆盖档位，由模型或上游决定默认行为。

任务开始信息会显示实际传入的 `reasoning` 值。还可以在任务完成后检查最新 Codex 原生会话中的 `turn_context`：

```bash
latest=$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name '*.jsonl' | sort | tail -1)
rg '"type":"turn_context"' "$latest" | tail -1
```

其中的 `effort` 可确认 Codex CLI 是否收到所选档位。第三方服务商是否完整支持该档位，仍取决于其上游实现。

## Homepage 小组件

设置 `HOMEPAGE_API_TOKEN` 后，可通过只读接口 `GET /api/homepage/stats` 获取 Codex App 原生会话数、服务商数、默认服务商模型数和运行中任务数。请求必须携带 `X-API-Token` 请求头：

```bash
curl -H "X-API-Token: $HOMEPAGE_API_TOKEN" http://localhost:36354/api/homepage/stats
```

Homepage 的 `services.yaml` 可使用内置 `customapi` 小组件：

```yaml
- AI 工具:
    - Codex Web:
        icon: codex-web.svg
        href: http://192.168.10.10:36354
        widget:
          type: customapi
          url: http://192.168.10.10:36354/api/homepage/stats
          headers:
            X-API-Token: "替换为 HOMEPAGE_API_TOKEN"
          mappings:
            - field: conversations
              label: 会话
              format: number
            - field: providers
              label: 供应商
              format: number
            - field: models
              label: 模型
              format: number
            - field: running
              label: 运行中
              format: number
```

模型数量按当前默认服务商的 `/models` 返回结果统计，并使用短期缓存，避免 Homepage 刷新时频繁访问上游。

## 会话说明

- Web 新建和续聊都直接使用 Codex App 原生线程，不再创建独立的 Web 会话。
- 最近会话来自 Codex App 本机索引，只显示未归档的普通用户线程；归档线程、自动化任务和子代理线程不会显示。
- 已在 Codex App 打开的线程会通过桌面 IPC 由 App 自己启动续聊、引导和取消，因此 App 窗口能立即收到用户消息与流式事件。
- App 未打开对应线程或桌面 IPC 不可用时，Web 会自动回退到持久 `codex app-server --stdio`；新建、改名、归档与审批仍通过 app-server 写回同一原生线程。
- 历史用户消息的“从这里重新开始”会通过 `thread/fork` 创建新线程并保留原会话；首轮消息会创建空白新线程。
- 历史分支只回退会话上下文，不会撤销已经产生的本地文件修改；原消息中的附件需要重新添加。
- 消息历史直接读取 `CODEX_HOME/session_index.jsonl`、`CODEX_HOME/state_5.sqlite` 与 `CODEX_HOME/sessions/`，通过文件监听和轮询兜底增量刷新。
- 旧版 `runtime/conversations.json` 仅保留兼容读取，不再显示在最近会话中。
- 浏览器关闭或 SSE 连接中断后，已经启动的 Codex 任务仍会在服务端继续运行；重新打开对应会话可查看结果。
- 手机切换应用、页面恢复或 SSE 重连时会保留已有流式内容，等对应 turn 的终止记录持久化后再用完整历史替换，避免短暂只剩用户消息。
- 同一时间运行任务时，部分会话编辑操作会被暂时禁止，以避免破坏执行中的数据。

## 数据存储

- Codex App 原生会话保存在 `CODEX_HOME/state_5.sqlite`、`CODEX_HOME/session_index.jsonl` 与 `CODEX_HOME/sessions/`
- 旧版 Web 会话可能仍保存在 `runtime/conversations.json`，仅作兼容数据保留
- 上传附件保存在 `runtime/uploads/`
- 外观设置和自定义背景保存在 `runtime/` 下
- 服务运行日志和临时文件也应保留在本地

这些文件属于本机运行数据，不建议提交到远程仓库。

## GitHub 部署说明

当前仓库只适合提交源码和依赖锁文件。推送前请确认：

```bash
git status --ignored
```

应确保以下内容没有进入暂存区：

```text
.env
runtime/
node_modules/
*.log
```

## 开发检查

修改代码后运行项目检查：

```bash
npm run check
```

提交 Pull Request 前还需要同步最新 `main` 并运行完整检查，具体流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

如服务已在后台运行，修改后需要重启进程才能生效。
