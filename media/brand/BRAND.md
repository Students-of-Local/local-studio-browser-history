# Tychicus brand

**Tychicus** is Paul's courier in the New Testament (Ephesians 6:21-22, Colossians 4:7-8): the
trusted one who carries the letters and does the errands. You send the work and it carries it out
in your browser. The brand should feel calm and capable, with the human in command. It is not an
"autonomous AI agent".

## Icon

A sealed letter on an olive tile, with an agent's pointer pressed into the wax seal: Tychicus the
letter-carrier, acting for you. It is drawn by hand, not generated.

| File | Use |
| --- | --- |
| `icon.svg` | App icon on a 64 grid: olive tile (`#4b5935`), paper envelope (`#f6f3e8`), rust seal (`#b8642e`) with the pointer cut out. Use at 32 px and up. |
| `icon-16.svg` | 16 px icon on its own grid, with a plain seal, because the pointer doesn't read at that size. |

The same two SVGs, trimmed, are `TYCHICUS_ICON` and `TYCHICUS_ICON_16` in
`src/components/tychicus-svg.ts`, with `TYCHICUS_MARK`, a one-color outline of the letter and seal in
`currentColor` for the side panel. Copies live at `media/video/public/brand/icon.svg` and
`site/src/frontend/public/img/icon.svg`. The extension icons come from them with
`rsvg-convert -w N -h N`: `static/icon-16.png` from `icon-16.svg`, and `icon-32`, `icon-48` and
`icon-128` from `icon.svg`. `test/tychicus-logo.test.mjs` fails when any copy drifts from these files
or a PNG isn't the size it claims. To change the icon, edit both SVGs here, copy them to those
places and make the PNGs again.

Rules:

- Keep the tile, envelope and seal as they are: no outlines, gradients or shadows on the icon itself.
- Don't rotate it. The pointer in the seal always points up and to the left.
- Never pair it with the Sitegeist orb, badlogic's marks or Polycarp's helm. Tychicus credits them in
  words, not in pictures.

## Old helm art, still to redo

`mark.svg`, `mark-brass.svg`, `hero.png`, `hero-light.png`, `social.png`, the site's social card
(`site/src/frontend/public/img/og.png`) and the video in `media/video` still show the Tabkyra helm, and
the heroes and cards still say Tabkyra. `build.mjs` draws them (`node media/brand/build.mjs`); it no
longer writes the icon files above. The palette and type below are the helm brand's. The side panel
uses its own olive palette instead (`src/app.css`, accent `--tk-brass: #59693f`), which the icon's
tile matches.

## Palette

| Name | Hex | Use |
| --- | --- | --- |
| Brass | `#E3A93B` | The tile, emphasis and the one accent color. Use it on ink, never as text on white. |
| Brass deep | `#A8761C` | Brass for text and focus rings on light backgrounds. |
| Ink | `#0F1B24` | The helm, dark surfaces and body text on paper. |
| Tide | `#43B3A0` | Success and "connected" states. |
| Paper | `#F6F2EA` | Light surfaces and text on ink. |
| Slate | `#6B7A86` | Secondary text. |

The side panel's dark theme tints the neutral grays toward ink (hue 240, chroma ~0.017).
Brass appears sparingly: the mark, the tutorial pills and the user's own messages.

## Type

| Role | Face | Where |
| --- | --- | --- |
| Display | Instrument Serif, italic | The line, site headings and accents |
| Text and wordmark | Instrument Sans, semibold for the wordmark | Site and hero |
| Code | JetBrains Mono | Commands, the CLI in screenshots |
| Extension UI | System UI stack | The side panel bundles no fonts |

All three fonts are OFL-licensed and come from `@fontsource` packages in `site/`.

The wordmark is "Tychicus" with a capital T, set in Instrument Sans semibold at -0.035em
tracking. Write the name as Tychicus in prose and as `tychicus` for the command.

## Voice

Plain, direct American English. Say what the tool does and what the user controls. Avoid
hype, "AI-powered", "autonomous" and "seamless". Safety statements are concrete: name
what is blocked and who approves.
