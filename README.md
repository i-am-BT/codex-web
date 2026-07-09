# Codex Web

一个轻量级的本地 Web 界面，用来在浏览器中运行和管理 Codex 会话。

## 安全提醒

本项目完全由 AI 制作，未经过正式安全审计。部署、公开访问或处理敏感数据前，请自行检查代码、依赖、配置、鉴权逻辑和运行环境安全。

## 功能

- 在浏览器里创建、切换和继续 Codex 会话
- 支持流式显示助手回复
- 支持上传图片、PDF、文本和代码附件
- 支持管理模型服务商和默认模型
- 支持删除服务商，且会防止删除最后一个服务商
- 支持回退到某一条用户消息，并删除该消息之后的会话历史
- 如果任务因异常、配置、网络或其他原因执行失败，允许回退到之前的消息后重新执行
- 提供健康检查接口：`/api/health`

## 环境要求

- Node.js 18 或更高版本
- npm
- 本机已配置可用的 Codex 环境

## 安装

```bash
npm install
```

## 配置

项目会从 `.env` 和本机 Codex 配置文件读取运行配置。

复制示例文件后再填写本机配置：

```bash
cp .env.example .env
```

`.env.example` 只包含脱敏占位符，可以提交到仓库；真实 `.env` 不要提交。

如果是新设备首次运行，还需要准备 Codex 配置：

- `/root/.codex/.env`：保存服务商 API Key，可参考 `codex.env.example`
- `/root/.codex/config.toml`：保存服务商和模型配置，可参考 `codex.config.example.toml`

也可以先启动 Web 界面，再通过“服务商管理”添加服务商和 API Key。

本仓库已默认忽略 `.env`、`runtime/` 和 `node_modules/`。请勿手动移除忽略规则或强制提交这些本地敏感/运行时文件。

## 启动

```bash
node server.mjs
```

启动后访问：

```text
http://localhost:36354
```

如果 `.env` 中配置了其他端口，请使用对应端口访问。

## 数据存储

- 会话历史保存在 `runtime/conversations.json`
- 上传附件保存在 `runtime/uploads/`
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

修改服务端代码后，可以先运行语法检查：

```bash
node --check server.mjs
```

如服务已在后台运行，修改后需要重启进程才能生效。
