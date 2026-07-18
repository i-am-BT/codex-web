# Dream Skin Theme Artwork Generator

Use this skill when a Codex Web task asks you to generate a chat background or
mentions Dream Skin. The generated bitmap is the artwork layer of a complete
theme pack. Codex Web applies the selected concept's real panel, accent, text,
border, focus, and translucency metadata on top of that artwork. The image
itself must remain a real wallpaper, not a prompt, mockup, screenshot, theme
preview, or application UI.

## Required Workflow

1. Read the user's visual request and inspect every attached reference image.
2. Choose one mode:
   - `no-person`: environment, abstract art, architecture, nature, or materials.
   - `fictional-adult`: at most one original, clearly adult fictional person.
   - `reference`: use uploaded images only according to the reference contract.
3. Use the available `imagegen` skill to generate the image. Do not stop after
   writing or refining a prompt.
4. Return one final opaque wallpaper image in the task response so Codex Web can
   offer it as a selectable Dream Skin theme while retaining the selected
   concept palette.

## Output Contract

- Target canvas: `2560 x 1440`, 16:9 landscape. If the generator cannot produce
  that exact size, use its highest-quality 16:9 output without stretching.
- The image must be continuous edge-to-edge artwork with one perspective and no
  visible seam or split-panel composition.
- Reserve `x=0%-52%` as a calm, low-information content-safe zone.
- Place the focal subject around `x=68%-76%`; keep essential details within
  `x=62%-88%` and `y=16%-72%`, at least 8% away from every edge.
- Keep faces around `y=20%-52%` and hands around `y=30%-70%`.
- Preserve usable midtones so the same image works beneath light and dark UI
  overlays. Avoid blank white and crushed black areas in the safe zone.
- Output an opaque PNG or high-quality JPEG. Do not edit Codex Web source files.
- Match the selected concept's dominant and secondary colors closely enough for
  the real Web controls and translucent surfaces to feel like one designed skin.

## Theme Integration Contract

- The reference may show a complete themed Codex window. Treat that screenshot
  as the target mood and composition, but generate only the underlying artwork.
- Do not bake fake controls into the bitmap. Codex Web owns the real sidebar,
  header, messages, cards, buttons, and composer and themes them from
  `concept-themes.json`.
- A generated revision must keep its selected `skin-01` through `skin-08`
  concept identity so the matching palette is applied when the image is chosen.
- The finished result is evaluated as artwork plus live themed controls, not as
  the wallpaper in isolation.

## Reference Contract

- Image 1 may be a UI screenshot or concept image. Use it only for palette,
  lighting, atmosphere, focal placement, and broad composition. Never erase UI
  from it or use it as an edit target.
- Image 2 may be a clean style, environment, or material reference. Use only its
  scenery, materials, color grading, depth, and lighting.
- Image 3 may preserve an adult identity only when the user explicitly confirms
  the necessary likeness and asset rights. Otherwise use an original fictional
  adult and do not infer identity from other images.
- Image numbers follow actual upload order. Do not refer to an omitted image.

## Hard Exclusions

Do not generate software windows, title bars, sidebars, panels, cards, rounded
rectangles, buttons, icons, input boxes, composers, chat boxes, code editors,
terminals, cursors, device frames, readable text, typography, names, signatures,
logos, labels, watermarks, posters, collages, or fake UI.

Do not imitate an unauthorized real person, public figure, private individual,
copyrighted character, brand mascot, or a living artist's signature style. Any
person must be clearly adult, anatomically natural, and free of duplicated faces,
extra limbs, malformed hands, or cropped critical details.

## Retry Rules

- UI still appears: regenerate from scratch and restate that references are
  visual references, never edit targets.
- The image looks split: continue one physical environment, perspective,
  lighting setup, and atmospheric depth through `x=0%-100%`.
- The subject is cropped: move all critical details back into the crop-safe
  coordinates instead of changing the wallpaper aspect ratio.
- The left side is blank: continue the same scene with subtle texture and
  midtones while keeping local contrast low.
- Text or logos appear: remove all requested copy and regenerate with the hard
  exclusions unchanged.

## Source Guidance

This condensed workflow is adapted from the Codex Dream Skin project:

- https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/docs/background-generation-prompts.md
- https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/docs/reference-background-prompt-guide.md

The bundled `LICENSE` and `NOTICE.md` apply to the vendored Dream Skin material.
