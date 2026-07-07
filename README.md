# Codex Web

一个轻量级的本地 Web 界面，用来在浏览器中运行和管理 Codex 会话。

## 功能

- 在浏览器里创建、切换和继续 Codex 会话
- 支持流式显示助手回复
- 支持上传图片、PDF、文本和代码附件
- 支持管理模型服务商和默认模型
- 支持删除服务商，且会防止删除最后一个服务商
- 支持回退到某一条用户消息，并删除该消息之后的会话历史
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

常见配置项示例：

```bash
PORT=36354
```

不要把 `.env`、`runtime/`、`node_modules/` 提交到 GitHub。它们已经在 `.gitignore` 中排除。

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
