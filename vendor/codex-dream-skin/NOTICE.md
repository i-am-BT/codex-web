# Codex Dream Skin Source Notice

This directory contains an adapted background-generation skill and a pinned
copy of concept guidance from:

- Repository: https://github.com/Fei-Away/Codex-Dream-Skin
- Commit: `a1c48b3a84cc64532196e624fdf33ee1277cb018`
- Vendored source: `docs/background-generation-prompts.md`
- Vendored SHA-256: `4f09aed525a5a8d497239c71ac893add8205273dd11c3e7d6c3325cf22baad8d`
- Additional guidance adapted into `SKILL.md`:
  `docs/reference-background-prompt-guide.md`

The Web UI exposes the eight `skin-01` through `skin-08` concept directions
defined by the vendored Markdown. Each concept has a generated 2560 x 1440
wallpaper under `wallpapers/` that can be applied directly. The generation
workflow remains available for creating a new version with extra requirements.

The wallpapers were generated on 2026-07-17 through the configured
`gpt-image-2` compatible endpoint using the corresponding vendored prompt.
They are new generated outputs, not cleaned or cropped copies of the upstream
gallery screenshots.

No upstream gallery screenshots, preset backgrounds, `theme.json` files, or
portrait assets are redistributed by this Web adaptation. The upstream concept
gallery images include application UI and are not used as wallpaper files.

The upstream material is distributed under the MIT license included in
`LICENSE`. This Web adaptation does not run the upstream CDP injector or modify
the official Codex desktop app.

Codex Dream Skin is an unofficial customization project and is not affiliated
with, endorsed by, or sponsored by OpenAI.
