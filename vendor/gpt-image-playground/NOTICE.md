# GPT Image Playground

The production files in `app/` were built from:

- Project: `CookSleep/gpt_image_playground`
- Source: https://github.com/CookSleep/gpt_image_playground
- Commit: `a10477581b3d43ac98d39777e4445625a9db113d`
- Version: `0.7.0`
- License: MIT, reproduced in `LICENSE`

Build commands:

```text
npm ci
npm run build
```

The included `package-lock.json` is the upstream lock refreshed with
`npm audit fix` before building. It pins DOMPurify 3.4.12 and produced a clean
production dependency audit on 2026-07-17.

This embedded build adds a small same-origin bridge in upstream `src/App.tsx`.
It accepts prompt text, image parameters, and reference images from the Codex
Web prompt library, then fills the Playground gallery composer. The bridge
does not submit an image request automatically and does not accept messages
from other origins.

Codex Web serves this build at `/playground/` behind its existing Web login.
The upstream caching service worker is replaced with a non-caching shim that
unregisters itself, so an authenticated page is not kept available offline
after logout. API profiles, keys, history, and images remain in the
Playground's browser-local storage and are not copied into Codex Web's server
configuration.
