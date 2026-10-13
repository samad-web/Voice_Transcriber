# Customer marks for the testimonial cards

Drop a file here, then point at it from `components/proof.tsx`. Nothing scans
this folder: the path is set per testimonial, so an unused file costs nothing
and a missing one cannot ship by accident.

## What is here (placed 2026-10-13)

| File | Customer | Fit | Source |
|---|---|---|---|
| `tnpsc-mentors.png` | TNPSC Mentors | `contain` | as supplied, 58x40 |
| `rd-interlock-bricks.png` | RD Interlock Bricks | `cover` | as supplied, 700x558 |
| `fortune-innovatives.png` | Fortune Innovatives | `cover` | **cropped**, 52x52 |

## Two of these needed a decision

**`fortune-innovatives.png` is not the file that was supplied.** What arrived
was the full lockup: a 371x52 navy bar reading "FORTUNE INNOVATIVES" beside a
cube glyph. No fit setting rescues that shape in a circle, so the glyph was cut
out of its left end:

```
ffmpeg -i "<the supplied bar>.png" -vf "crop=52:52:0:0" fortune-innovatives.png
```

If they ever send the glyph on its own, overwrite the file and delete the note
in `proof.tsx` that explains the crop. No other change is needed.

**`tnpsc-mentors.png` is too small at 58x40.** The circle renders at 80px and is
served at 2x for retina, so this is being scaled past twice its native size and
looks soft. Nothing can recover detail that is not in the file. Ask TNPSC
Mentors for the original at 160px or more on the short side and overwrite the
file; no code changes with it.

## Choosing `logoFit`

- **`contain`** (the default) for a mark with a transparent or white
  background. It sits whole inside the circle with padding, nothing cropped.
- **`cover`** for artwork carrying its own background: a photograph, or a glyph
  on a coloured bar. `contain` would leave that background as a visible square
  inside a round frame, which reads as a rendering fault. `cover` fills the
  circle and crops the corners.

RD Interlock is `cover` because its monogram is painted over a photographed
brick wall; filling the circle also crops the "INTERLOCK BRICKS" wordmark off
the bottom, leaving the part that survives at 80px.

## What works in a circle

- Square or near-square artwork. Not a horizontal wordmark.
- At least 160px on the short side.
- PNG, WebP or SVG. `next/image` optimises the raster formats; an SVG is served
  as-is, so make sure it carries no embedded raster bloat.

A customer with no usable file falls back to their initials in the circle,
which is a deliberate-looking state rather than a gap.
