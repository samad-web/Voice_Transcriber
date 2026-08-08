// Capture the Aura hero call card as a looping GIF.
//
// Same recipe as TNPSC's scripts/make-commercial.mjs: Playwright records a
// webm, ffmpeg converts it with a two-pass palette (palettegen → paletteuse),
// which is what keeps gradients from banding into mud.
//
// Two things make the loop seamless rather than jumping on repeat:
//
//   1. The animation periods are overridden to divide evenly. The waveform runs
//      1.5s `alternate`, so one full there-and-back is 3s. The language fade
//      runs 6s. 6 = 2 × 3, so the whole card returns to its exact starting
//      state every 6 seconds.
//   2. Because of that, ANY 6-second slice of the recording is a perfect loop.
//      So we record ~13s and cut from the middle, which sidesteps having to
//      time the cut against page load.
//
// reducedMotion is forced to 'no-preference': this machine has Windows
// animation effects switched off, so Chromium would otherwise inherit
// prefers-reduced-motion: reduce and record a frozen card.

import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// Playwright is not a dependency of this app and should not become one — it
// would put a browser download in every CI install for a script that runs by
// hand, a few times a year. PLAYWRIGHT env var overrides if it lives elsewhere.
const PW = process.env.PLAYWRIGHT
  ?? 'C:/Users/mas20/Desktop/work/TNPSC/TNPSC-Academy/tnpsc-mentor/node_modules/playwright/index.mjs'
let chromium
try {
  ({ chromium } = await import(pathToFileURL(PW).href))
} catch {
  console.error(`Could not load Playwright from ${PW}
Set PLAYWRIGHT=/path/to/playwright/index.mjs`)
  process.exit(1)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light'
const OUT_DIR = path.join(HERE, `.gif-work-${THEME}`)  // scratch; safe to delete
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')
const STEM = THEME === 'dark' ? 'hero-card-dark' : 'hero-card'
const TARGET = `${PUBLIC}/${STEM}.gif`
const TARGET_WEBP = `${PUBLIC}/${STEM}.webp`
// The page ground behind the card, per theme — brand.css --mk-ground.
// Capture the CARD FACE ONLY. The ground is the card's own surface so the
// few pixels outside its rounded corners blend away; CSS re-adds the radius
// and the shadow on the page. Baking a flat page-ground into the image made
// a hard-edged rectangle that was plainly visible against the hero's
// gradient wash.
const GROUND = THEME === 'dark' ? '#0f1621' : '#ffffff'
// The dedicated capture stage, NOT the homepage: the homepage now ships the
// image, so '.mk-card' there matches an outcome card instead.
const URL = process.env.URL ?? 'http://localhost:3200/capture/hero-card'
const PAD = 0

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

// ── Pass 1: measure the card so the viewport can be sized to it exactly ──────
// Cropping a big screenshot down would throw away resolution; sizing the
// viewport to the subject means every recorded pixel is a pixel we keep.
const probe = await chromium.launch()
const probeCtx = await probe.newContext({
  viewport: { width: 1440, height: 1000 },
  colorScheme: THEME,
  reducedMotion: 'no-preference',
})
const probePage = await probeCtx.newPage()
await probePage.goto(URL, { waitUntil: 'networkidle' })
const box = await probePage.locator('#call-card').boundingBox()
await probe.close()

if (!box) throw new Error('Could not find .mk-card on the page')
// 2x. Playwright encodes the video at recordVideo.size and will not supersample
// for us, so the only way to get real retina detail is to make the page itself
// twice as big — CSS `zoom` on the body — and record a surface twice the size.
// deviceScaleFactor alone does nothing for video output.
const SCALE = Number(process.env.CAPTURE_SCALE ?? 2)
const W = (Math.ceil(box.width) + PAD * 2) * SCALE
const H = (Math.ceil(box.height) + PAD * 2) * SCALE
console.log(`card ${Math.round(box.width)}×${Math.round(box.height)} → viewport ${W}×${H}`)

// ── Pass 2: isolate the card and record it ───────────────────────────────────
const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,          // render crisp, downscale later
  colorScheme: THEME,
  reducedMotion: 'no-preference',
  // Playwright encodes at the size given here; it must match the viewport or
  // the page gets painted into a corner of a larger frame.
  recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
})
const page = await context.newPage()
await page.goto(URL, { waitUntil: 'networkidle' })

// Lift the card out of the page and drop it onto a clean ground. Grabbing the
// reference BEFORE clearing the body matters: the node survives its ancestors
// being detached because we still hold it, and re-appending restarts its
// animations from zero.
await page.evaluate(({ pad, ground, scale }) => {
  const card = document.querySelector('#call-card')
  document.body.replaceChildren(card)
  document.documentElement.style.background = ground
  document.body.style.cssText =
    `margin:0;padding:${pad}px;background:${ground};display:block;overflow:hidden`
  card.style.margin = '0'
  // No shadow in the raster — CSS draws it, so it stays theme-aware and
  // does not darken the image edges.
  card.style.boxShadow = 'none'
  card.style.border = 'none'
  document.body.style.zoom = String(scale)

  // Periods that divide evenly — see the header comment.
  const s = document.createElement('style')
  s.textContent = `
    .mk-wave-bar { animation-duration: 1.5s !important; }
    .mk-lang-a, .mk-lang-b { animation-duration: 6s !important; }
  `
  document.head.appendChild(s)
}, { pad: PAD, ground: GROUND, scale: SCALE })

await page.waitForTimeout(13000)
await context.close()
await browser.close()

const webm = readdirSync(OUT_DIR).filter((f) => f.endsWith('.webm')).map((f) => path.join(OUT_DIR, f))[0]
if (!webm) throw new Error('Playwright produced no video')
console.log(`recorded ${(statSync(webm).size / 1e6).toFixed(1)} MB webm`)

// ── Pass 3: webm → gif ───────────────────────────────────────────────────────
// Cut 6s from the middle (any 6s window is a full period), 13 fps, lanczos
// downscale, then the two-pass palette. bayer dithering rather than the default
// error-diffusion: on a smooth brand gradient, error diffusion crawls between
// frames and looks like static.
const FPS = process.env.FPS ?? '12'
const WIDTH = process.env.GIF_WIDTH ?? String(W)

// dither=none, and this is the single biggest change to how the text reads.
// Bayer dithering scatters pixels to fake colours the palette lacks. On a photo
// that reads as film grain; on 11px uppercase labels it reads as the text being
// out of focus, which is exactly what was wrong with the first pass. This card
// is mostly flat fills and one gradient, so a 256-entry palette covers it
// almost exactly and needs no dithering at all.
//
// stats_mode=diff weights the palette toward the pixels that CHANGE between
// frames — the waveform and the transcript — rather than spending entries on
// the large static white areas.
const filters =
  `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,split[s0][s1]` +
  `;[s0]palettegen=max_colors=256:stats_mode=diff[p]` +
  `;[s1][p]paletteuse=dither=none`

execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-ss', '4', '-t', '6', '-i', webm,
  '-vf', filters, '-loop', '0', TARGET,
], { stdio: 'inherit' })

execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-ss', '4', '-t', '6', '-i', webm,
  '-vf', `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`,
  '-loop', '0', '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '80',
  '-compression_level', '6', TARGET_WEBP,
], { stdio: 'inherit' })

const mb = (f) => (statSync(f).size / 1e6).toFixed(2)
console.log(`
[${THEME}] ${STEM}.gif  ${mb(TARGET)} MB`)
console.log(`[${THEME}] ${STEM}.webp ${mb(TARGET_WEBP)} MB`)
