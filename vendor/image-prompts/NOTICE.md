# Image Prompt Sources

This directory contains or adapts MIT-licensed material from:

- `freestylefly/awesome-gpt-image-2` at commit
  `60b6e1d3ddaf1c982426d6c8181827764c6b2012`
  - Vendored prompt cases and style/template metadata.
  - Original repository: https://github.com/freestylefly/awesome-gpt-image-2
  - License: `LICENSE.awesome-gpt-image-2`
- `CookSleep/gpt_image_playground` at commit
  `a10477581b3d43ac98d39777e4445625a9db113d`
  - Complete production application vendored at
    `../gpt-image-playground/app/` and mounted at `/playground/`.
  - Interaction patterns are also adapted for prompt parameters, reference
    images, favorites, and Codex App handoff in the prompt library.
  - Original repository: https://github.com/CookSleep/gpt_image_playground
  - License: `LICENSE.gpt-image-playground`

The prompt library can continue to prepare tasks for Codex App. The separate
Playground view calls user-configured image APIs directly from the browser and
keeps its profiles and API keys in browser-local storage.
