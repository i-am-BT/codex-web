# Codex Web

A lightweight local web interface for running Codex sessions.

## Setup

```bash
npm install
node server.mjs
```

Configuration is read from `.env` and local Codex configuration files. Do not commit `.env` or `runtime/`.

## Notes

- Runtime conversations and uploaded attachments are stored under `runtime/`.
- Provider credentials should stay in local environment/config files only.
- The web service exposes a health endpoint at `/api/health`.
