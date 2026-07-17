# GPT Image Playground

The production files in `app/` were built from:

- Project: `CookSleep/gpt_image_playground`
- Source: https://github.com/CookSleep/gpt_image_playground
- Commit: `a10477581b3d43ac98d39777e4445625a9db113d`
- Version: `0.7.0`
- License: MIT, reproduced in `LICENSE`

Rebuild from a clean checkout of the pinned commit:

```text
cp vendor/gpt-image-playground/package-lock.json <upstream-checkout>/package-lock.json
git -C <upstream-checkout> apply <codex-web-checkout>/vendor/gpt-image-playground/patches/codex-web.patch
cd <upstream-checkout>
npm ci
npm run build
rsync -a --delete --exclude sw.js dist/ <codex-web-checkout>/vendor/gpt-image-playground/app/
```

The included `package-lock.json` is the upstream lock refreshed with
`npm audit fix` before building. It pins DOMPurify 3.4.12 and produced a clean
production dependency audit on 2026-07-17.

This embedded build adds a small same-origin bridge in upstream `src/App.tsx`.
It accepts prompt text, image parameters, and reference images from the Codex
Web prompt library, then fills the Playground gallery composer. The bridge
does not submit an image request automatically and does not accept messages
from other origins.

The patch also completes the gallery composer's `@` reference flow. Typing
`@` with no current reference images now offers an upload action; after a
successful upload, the reference picker reopens so the new image can be
inserted as an explicit mention.

When embedded in Codex Web, the build imports a paired image and Agent profile
from the authenticated `/api/playground-config` endpoint. Gallery requests and
Agent image tools use the Images API profile, while Agent conversations use the
Codex provider's Responses API profile. Both profiles refresh their URL and
credential on each load. The image profile preserves a previously chosen image
model and initially uses `gpt-image-2`; the Agent profile follows the current
Codex text model. Codex CLI compatibility mode remains enabled only on the image
profile, so multi-image requests are split into concurrent single-image calls
instead of sending an unsupported `n` parameter to Codex-compatible image
gateways.

Codex Web serves this build at `/playground/` behind its existing Web login.
The upstream caching service worker is replaced with a non-caching shim that
unregisters itself, so an authenticated page is not kept available offline
after logout. API profiles, keys, history, and images remain in the
Playground's browser-local storage and are not copied into Codex Web's server
configuration.
