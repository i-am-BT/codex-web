# Dream Skin Wallpapers

These eight wallpaper assets were generated on 2026-07-17 from the matching
`skin-01` through `skin-08` sections in
`../background-generation-prompts.md`.

- Output: 2560 x 1440 JPEG, opaque, 16:9
- Generator: the configured `gpt-image-2` compatible Images API
- Source handling: generated from text prompts; upstream gallery screenshots
  were not used as edit targets or copied into these files
- Runtime values: `dream:skin-01` through `dream:skin-08`

Regenerate one or more assets with:

```bash
npm run generate:dream-skin -- skin-03 skin-08 --force
```

The generator reads the existing Codex provider configuration and never prints
the provider credential.
