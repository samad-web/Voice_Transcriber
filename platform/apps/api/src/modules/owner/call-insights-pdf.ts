import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import PDFDocument from "pdfkit";
import {
  type CallInsightsReport,
  type CallInsightsTotals,
  callInsightsHighlights,
  callInsightsKpis,
  countChange,
  formatCallLength,
  formatCount,
  formatCountChange,
  formatHourSlot,
  formatPointChange,
  formatReportDate,
  formatReportRange,
  formatShare,
  formatTalkTime,
  outcomeLabel,
  pointChange,
  ratio,
  sentimentLabel,
  volumeSeries,
} from "@aura/shared";

/**
 * Call insights as a PDF - a real file, generated here, downloaded in one click.
 *
 * ── WHY PDFKIT, WHEN THE REPORT BUILDER CHOSE `window.print()` ──────────────
 *
 * `report_builder_design.md` D1 rejected html2canvas (raster - text stops
 * being text) and Puppeteer (~300MB of Chromium in the API image), and took a
 * print route instead. That trade was stated honestly: "the user sees the OS
 * print dialog rather than a file landing in Downloads". This report exists to
 * be downloaded and passed on, which is precisely the half D1 gave up.
 *
 * pdfkit is the option D1 did not weigh: pure JavaScript, no browser, VECTOR
 * output - selectable text, embedded (subset) fonts, charts drawn as paths - so
 * both of D1's objections are met. What it costs is that layout is ours: page
 * breaks are decided by `ensure()` below rather than by a CSS engine. That is
 * tolerable for a report whose shape is fixed, and would not be for the Report
 * Builder's arbitrary canvases, which is why the two do not share a renderer.
 *
 * ── FONTS ───────────────────────────────────────────────────────────────────
 *
 * pdfkit's built-in Helvetica is WinAnsi-only: no ₹, and a Tamil contact name
 * would print as garbage. So Noto Sans is embedded (Latin/Greek/Cyrillic, ₹),
 * with Noto Sans Tamil and Devanagari as fallbacks, chosen PER CHARACTER RUN -
 * the Tamil face has no Latin letters, so "முருகன் Arun" is two runs in two
 * fonts on one line. Summaries and intents are written in English by the
 * analyzer, so the fallbacks only ever carry names. A script no bundled face
 * covers renders as the font's missing-glyph box rather than failing the file.
 * Only the glyphs used are embedded, so a typical report is tens of KB.
 *
 * ── COLOUR ON PAPER ─────────────────────────────────────────────────────────
 *
 * The console's state rule holds here too (packages/ui/src/state.tsx): the
 * four call states carry their hues - outgoing blue, answered green, missed
 * red - and everything else is grey. Fixed hexes rather than tokens because
 * paper has no theme (the same exemption printable-report.tsx has). Each
 * state's legend also draws its GLYPH, because this file will be printed in
 * greyscale and forwarded on WhatsApp, where hue alone is lost.
 *
 * ── WHAT NEVER GOES IN ──────────────────────────────────────────────────────
 *
 * Transcript text and risk-flag snippets: the report contract does not carry
 * them (call-insights.query.ts), so this file could not print them if it
 * tried. The attention list carries the AI summary, which the call log already
 * shows the same readers, and the whole list can be left out (`includeCalls`).
 */

// ── Geometry & palette ──────────────────────────────────────────────────────

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const LEFT = 42;
const RIGHT = PAGE_W - 42;
const TOP = 44;
const BOTTOM = PAGE_H - 52; // content stops here; the footer lives below
const WIDTH = RIGHT - LEFT;

const INK = "#171717";
const MUTED = "#5c5c5c";
const SUBTLE = "#8a8a8a";
const RULE = "#e3e3e3";
const RULE_STRONG = "#bdbdbd";
const WASH = "#f4f4f4";
/** Magnitude that is not a state: one neutral ink. */
const BAR = "#6b6b6b";

const STATE = {
  outgoing: "#2563eb",
  answered: "#16a34a",
  missed: "#dc2626",
} as const;
type ChartState = keyof typeof STATE;
const STACK_ORDER: ChartState[] = ["outgoing", "answered", "missed"];
const STATE_LABEL: Record<ChartState, string> = {
  outgoing: "Outgoing",
  answered: "Answered",
  missed: "Missed",
};

// ── Fonts ───────────────────────────────────────────────────────────────────

type Weight = "regular" | "bold";

interface FontFace {
  name: string;
  data: Buffer;
  /** fontkit's coverage check; null when fontkit could not be loaded. */
  has: ((codePoint: number) => boolean) | null;
}

interface FontSet {
  regular: FontFace;
  bold: FontFace;
  fallbacks: FontFace[];
}

const FONT_FILES = {
  regular: "NotoSans-Regular.ttf",
  bold: "NotoSans-SemiBold.ttf",
  fallbacks: ["NotoSansTamil-Regular.ttf", "NotoSansDevanagari-Regular.ttf"],
};

/**
 * `assets/fonts` sits beside `src/` and `dist/`, so it is found by walking up
 * from this file - which is `src/modules/owner` under ts-jest and
 * `dist/modules/owner` in production, and in the image the Dockerfile copies
 * `apps/api/assets` next to `dist` for exactly this. Bounded, and it fails
 * with the path it looked for rather than rendering Helvetica-shaped garbage.
 */
export function findFontDir(start: string = __dirname): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "assets", "fonts");
    if (existsSync(join(candidate, FONT_FILES.regular))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`call insights PDF: fonts not found above ${start} (expected assets/fonts/${FONT_FILES.regular})`);
}

let cachedFonts: FontSet | null = null;

/** Read once per process: the files are ~1MB together and never change. */
function loadFonts(): FontSet {
  if (cachedFonts) return cachedFonts;
  const dir = findFontDir();
  // fontkit is pdfkit's own dependency; reached through pdfkit so the two can
  // never disagree about a font, and so the API does not declare a package it
  // only uses to ask one question.
  let create: ((data: Buffer) => { hasGlyphForCodePoint(cp: number): boolean }) | null = null;
  try {
    const fontkit = createRequire(require.resolve("pdfkit"))("fontkit") as {
      create: (data: Buffer) => { hasGlyphForCodePoint(cp: number): boolean };
    };
    create = fontkit.create;
  } catch {
    create = null;
  }
  const face = (name: string, file: string): FontFace => {
    const data = readFileSync(join(dir, file));
    const font = create ? create(data) : null;
    return { name, data, has: font ? (cp) => font.hasGlyphForCodePoint(cp) : null };
  };
  cachedFonts = {
    regular: face("sans", FONT_FILES.regular),
    bold: face("sans-bold", FONT_FILES.bold),
    fallbacks: FONT_FILES.fallbacks.map((file, i) => face(`fallback-${i}`, file)),
  };
  return cachedFonts;
}

// ── Text, with per-script runs ──────────────────────────────────────────────

interface Run {
  font: string;
  text: string;
}

interface TextStyle {
  size: number;
  weight?: Weight;
  color?: string;
}

class Writer {
  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly fonts: FontSet,
  ) {}

  /** Split a string into runs, each in the first face that has its glyphs. */
  runs(text: string, weight: Weight = "regular"): Run[] {
    const primary = weight === "bold" ? this.fonts.bold : this.fonts.regular;
    if (!primary.has) return [{ font: primary.name, text }];
    const out: Run[] = [];
    let current: FontFace = primary;
    for (const ch of Array.from(text)) {
      const cp = ch.codePointAt(0) ?? 32;
      let face: FontFace;
      if (current !== primary && current.has?.(cp) && !isLatinLetter(cp)) {
        // Stay in the fallback for spaces, marks and punctuation it has, so a
        // Tamil name is one run rather than one per word.
        face = current;
      } else if (primary.has(cp)) {
        face = primary;
      } else {
        face = this.fonts.fallbacks.find((f) => f.has?.(cp)) ?? primary;
      }
      const last = out[out.length - 1];
      if (last && last.font === face.name) last.text += ch;
      else out.push({ font: face.name, text: ch });
      current = face;
    }
    return out;
  }

  width(text: string, style: TextStyle): number {
    let w = 0;
    for (const run of this.runs(text, style.weight)) {
      w += this.doc.font(run.font).fontSize(style.size).widthOfString(run.text);
    }
    return w;
  }

  /** Truncate with an ellipsis to fit `max` points. */
  fit(text: string, max: number, style: TextStyle): string {
    if (this.width(text, style) <= max) return text;
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.width(`${chars.slice(0, mid).join("").trimEnd()}…`, style) <= max) lo = mid;
      else hi = mid - 1;
    }
    return lo === 0 ? "…" : `${chars.slice(0, lo).join("").trimEnd()}…`;
  }

  /**
   * One line of text with its TOP at `top`. Runs are placed on a shared
   * alphabetic baseline, because the fallback faces have taller ascenders and
   * top-aligning them would make a Tamil name sit visibly low.
   */
  line(
    text: string,
    x: number,
    top: number,
    style: TextStyle & { width?: number; align?: "left" | "right" | "center"; spacing?: number },
  ): number {
    const shown = style.width !== undefined ? this.fit(text, style.width, style) : text;
    const w = this.width(shown, style);
    let cx = x;
    if (style.width !== undefined && style.align === "right") cx = x + style.width - w;
    if (style.width !== undefined && style.align === "center") cx = x + (style.width - w) / 2;
    const baseline = top + style.size * 0.96;
    this.doc.fillColor(style.color ?? INK);
    for (const run of this.runs(shown, style.weight)) {
      this.doc
        .font(run.font)
        .fontSize(style.size)
        .text(run.text, cx, baseline, {
          lineBreak: false,
          baseline: "alphabetic",
          characterSpacing: style.spacing ?? 0,
        });
      cx += this.doc.widthOfString(run.text, { characterSpacing: style.spacing ?? 0 });
    }
    return w;
  }

  /** Word-wrapped lines, at most `maxLines`, the last one ellipsised if cut. */
  wrap(text: string, width: number, style: TextStyle, maxLines = Number.POSITIVE_INFINITY): string[] {
    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (this.width(candidate, style) <= width) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = this.width(word, style) <= width ? word : this.fit(word, width, style);
    }
    if (current) lines.push(current);
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      kept[maxLines - 1] = this.fit(`${kept[maxLines - 1]} ${lines[maxLines]}`, width, style);
      if (!kept[maxLines - 1].endsWith("…")) kept[maxLines - 1] = this.fit(`${kept[maxLines - 1]}…`, width, style);
      return kept;
    }
    return lines;
  }

  /** Wrapped paragraph; returns the height it used. */
  paragraph(
    text: string,
    x: number,
    top: number,
    width: number,
    style: TextStyle & { leading?: number; maxLines?: number },
  ): number {
    const leading = style.leading ?? style.size * 1.42;
    const lines = this.wrap(text, width, style, style.maxLines);
    lines.forEach((l, i) => this.line(l, x, top + i * leading, style));
    return lines.length * leading;
  }

  paragraphHeight(text: string, width: number, style: TextStyle & { leading?: number; maxLines?: number }): number {
    return this.wrap(text, width, style, style.maxLines).length * (style.leading ?? style.size * 1.42);
  }
}

function isLatinLetter(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f);
}

// ── Small formatters specific to paper ──────────────────────────────────────

/** "21 Sep 2026, 12:40" in the org's zone; UTC if this runtime lacks the zone. */
function formatGenerated(iso: string, timeZone: string): string {
  const date = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${formatReportDate(`${get("year")}-${get("month")}-${get("day")}`)}, ${get("hour")}:${get("minute")}`;
  } catch {
    return `${formatReportDate(iso.slice(0, 10))}, ${iso.slice(11, 16)} UTC`;
  }
}

/** A call's start as a floor reads it, in the org's zone. */
function formatCallTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const period = get("dayPeriod").toUpperCase();
    return `${formatReportDate(`${get("year")}-${get("month")}-${get("day")}`, false)}, ${get("hour")}:${get("minute")} ${period}`.trim();
  } catch {
    return `${formatReportDate(iso.slice(0, 10), false)}, ${iso.slice(11, 16)} UTC`;
  }
}

function changeVs(current: number, previous: number): string {
  const text = formatCountChange(countChange(current, previous));
  return text === "new" ? "none in previous period" : `${text} vs ${formatCount(previous)}`;
}

// ── The document ────────────────────────────────────────────────────────────

export interface CallInsightsPdfOptions {
  /** False leaves the per-call attention list (names, summaries) out entirely. */
  includeCalls?: boolean;
}

export function renderCallInsightsPdf(
  report: CallInsightsReport,
  options: CallInsightsPdfOptions = {},
): Promise<Buffer> {
  const includeCalls = options.includeCalls ?? true;
  const fonts = loadFonts();
  const rangeText = formatReportRange(report.range.from, report.range.to);

  const doc = new PDFDocument({
    size: "A4",
    // Margins are ours (see TOP/BOTTOM). pdfkit's own would make it add a page
    // on its own whenever text lands in the footer band.
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true,
    autoFirstPage: true,
    lang: "en",
    displayTitle: true,
    info: {
      Title: `Call insights - ${report.org.name} - ${rangeText}`,
      Author: report.org.name,
      Subject: `Call insights report for ${rangeText}`,
      Keywords: "call insights, call analytics, report",
      Creator: "Aura Call Intelligence",
      CreationDate: new Date(report.generatedAt),
    },
  });

  doc.registerFont(fonts.regular.name, fonts.regular.data);
  doc.registerFont(fonts.bold.name, fonts.bold.data);
  for (const f of fonts.fallbacks) doc.registerFont(f.name, f.data);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const w = new Writer(doc, fonts);
  const layout = new Layout(doc, w);

  drawHeader(layout, w, report);
  drawKpis(layout, w, report);
  drawHighlights(layout, w, report);
  drawVolume(layout, w, report);
  drawHours(layout, w, report);
  drawConversationRead(layout, w, report);
  drawQuality(layout, w, report);
  drawRisk(layout, w, report);
  drawPeople(layout, w, report);
  if (includeCalls) drawAttention(layout, w, report);
  drawNotes(layout, w, report, includeCalls);
  drawFooters(doc, w, report, rangeText);

  doc.end();
  return done;
}

/** A y cursor with page breaks - the part a CSS engine would otherwise own. */
class Layout {
  y = TOP;

  constructor(
    readonly doc: PDFKit.PDFDocument,
    private readonly w: Writer,
  ) {}

  /** Start a new page unless `height` still fits on this one. */
  ensure(height: number): void {
    if (this.y + height > BOTTOM) this.newPage();
  }

  newPage(): void {
    this.doc.addPage({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    this.y = TOP;
  }

  /**
   * A section heading, kept with at least `keep` points of what follows it -
   * a heading stranded at the foot of a page is the classic hand-laid-out
   * report bug. Also a bookmark, so a long report is navigable.
   */
  section(title: string, subtitle: string | null, keep: number): void {
    // Measure the heading exactly as it is about to be drawn - spacing above,
    // title, subtitle - or the check passes and the heading still strands.
    const head = 17 + (subtitle ? 13 : 0) + 6;
    this.ensure((this.y > TOP ? 16 : 0) + head + keep);
    if (this.y > TOP) this.y += 16;
    this.doc.outline.addItem(title);
    this.w.line(title, LEFT, this.y, { size: 12, weight: "bold" });
    this.y += 17;
    if (subtitle) {
      this.w.line(subtitle, LEFT, this.y, { size: 8.5, color: MUTED, width: WIDTH });
      this.y += 13;
    }
    this.y += 6;
  }

  rule(color = RULE, weight = 0.75): void {
    this.doc.moveTo(LEFT, this.y).lineTo(RIGHT, this.y).lineWidth(weight).strokeColor(color).stroke();
  }
}

// ── Sections ────────────────────────────────────────────────────────────────

function drawHeader(l: Layout, w: Writer, r: CallInsightsReport): void {
  w.line("CALL INSIGHTS REPORT", LEFT, l.y, { size: 7.5, weight: "bold", color: SUBTLE, spacing: 0.9 });
  l.y += 14;
  w.line(r.org.name, LEFT, l.y, { size: 20, weight: "bold", width: WIDTH });
  l.y += 29;
  w.line(`${formatReportRange(r.range.from, r.range.to)}  ·  ${formatCount(r.range.days)} day${r.range.days === 1 ? "" : "s"}`, LEFT, l.y, {
    size: 10.5,
  });
  l.y += 15;
  w.line(
    `Compared with ${formatReportRange(r.previousRange.from, r.previousRange.to)}  ·  Times in ${r.org.timezone}  ·  Generated ${formatGenerated(r.generatedAt, r.org.timezone)}`,
    LEFT,
    l.y,
    { size: 8, color: MUTED, width: WIDTH },
  );
  l.y += 18;
  l.rule(RULE_STRONG, 1);
  l.y += 16;
}

interface Tile {
  label: string;
  value: string;
  foot: string;
  state?: ChartState;
}

function kpiTiles(r: CallInsightsReport): Tile[] {
  const c = r.current;
  const p = r.previous;
  const k = callInsightsKpis(c);
  const pk = callInsightsKpis(p);
  const inbound = c.answered + c.missed;
  const qualityMove =
    c.avgQuality !== null && p.avgQuality !== null ? Math.round(c.avgQuality - p.avgQuality) : null;
  return [
    { label: "Calls", value: formatCount(c.total), foot: changeVs(c.total, p.total) },
    {
      label: "Connect rate",
      value: formatShare(k.connectRate),
      // No previous rate means no comparison, not a dash in its place.
      foot: `${pk.connectRate === null ? "" : `${formatPointChange(pointChange(k.connectRate, pk.connectRate))} · `}${formatCount(c.connected)} connected`,
    },
    { label: "Missed calls", value: formatCount(c.missed), foot: changeVs(c.missed, p.missed), state: "missed" },
    {
      label: "Talk time",
      value: formatTalkTime(c.talkSeconds),
      foot: `Avg call ${formatCallLength(k.avgCallSeconds)}`,
    },
    {
      label: "Inbound answered",
      value: formatShare(k.answerRate),
      foot: inbound === 0 ? "No inbound calls" : `${formatCount(c.answered)} of ${formatCount(inbound)} inbound`,
      state: "answered",
    },
    {
      label: "Positive calls",
      value: formatShare(k.positiveShare),
      foot: c.analyzed === 0 ? "No AI read yet" : `${formatShare(k.negativeShare)} negative · ${formatCount(c.analyzed)} analysed`,
    },
    {
      label: "Avg quality",
      value: c.avgQuality === null ? "–" : `${Math.round(c.avgQuality)}/100`,
      foot:
        c.scored === 0
          ? "No calls scored"
          : `${formatCount(c.scored)} scored${qualityMove === null ? "" : ` · ${qualityMove === 0 ? "no change" : `${qualityMove > 0 ? "+" : "−"}${Math.abs(qualityMove)} vs previous`}`}`,
    },
    {
      label: "Escalation risk",
      value: formatCount(c.riskCalls),
      foot: c.analyzed === 0 ? "No AI read yet" : `${formatShare(ratio(c.riskCalls, c.analyzed))} of analysed calls`,
    },
  ];
}

function drawKpis(l: Layout, w: Writer, r: CallInsightsReport): void {
  const tiles = kpiTiles(r);
  const gap = 8;
  const tileW = (WIDTH - gap * 3) / 4;
  const tileH = 60;
  l.ensure(tileH * 2 + gap);
  tiles.forEach((tile, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = LEFT + col * (tileW + gap);
    const y = l.y + row * (tileH + gap);
    l.doc.roundedRect(x, y, tileW, tileH, 4).lineWidth(0.75).strokeColor(RULE).stroke();
    let labelX = x + 10;
    if (tile.state) {
      drawGlyph(l.doc, tile.state, labelX, y + 10.5, 7);
      labelX += 11;
    }
    w.line(tile.label, labelX, y + 8, { size: 7.5, color: MUTED, width: tileW - (labelX - x) - 8 });
    w.line(tile.value, x + 10, y + 22, { size: 16, weight: "bold", width: tileW - 20 });
    w.line(tile.foot, x + 10, y + 44, { size: 6.8, color: MUTED, width: tileW - 20 });
  });
  l.y += tileH * 2 + gap;
}

function drawHighlights(l: Layout, w: Writer, r: CallInsightsReport): void {
  const lines = callInsightsHighlights(r);
  const style = { size: 9, leading: 13 };
  const heights = lines.map((t) => w.paragraphHeight(t, WIDTH - 14, style));
  l.section("Highlights", null, heights[0] ?? 13);
  lines.forEach((text, i) => {
    l.ensure(heights[i] + 4);
    l.doc.circle(LEFT + 3, l.y + 5.2, 1.6).fillColor(SUBTLE).fill();
    l.y += w.paragraph(text, LEFT + 12, l.y, WIDTH - 14, style) + 4;
  });
}

// ── Stacked state columns (daily and hourly share this) ─────────────────────

interface Bucket {
  label: string;
  outgoing: number;
  answered: number;
  missed: number;
}

function drawGlyph(doc: PDFKit.PDFDocument, state: ChartState, x: number, y: number, size: number): void {
  // The console's silhouettes (state.tsx): arrow, filled disc, slashed ring.
  const r = size / 2;
  const cx = x + r;
  const cy = y + r;
  const color = STATE[state];
  doc.save();
  if (state === "answered") {
    doc.circle(cx, cy, r * 0.8).fillColor(color).fill();
  } else if (state === "missed") {
    doc.circle(cx, cy, r * 0.72).lineWidth(size * 0.15).strokeColor(color).stroke();
    doc
      .moveTo(cx - r * 0.55, cy + r * 0.55)
      .lineTo(cx + r * 0.55, cy - r * 0.55)
      .lineWidth(size * 0.15)
      .lineCap("round")
      .strokeColor(color)
      .stroke();
  } else {
    doc
      .moveTo(cx - r * 0.5, cy + r * 0.5)
      .lineTo(cx + r * 0.5, cy - r * 0.5)
      .moveTo(cx - r * 0.15, cy - r * 0.5)
      .lineTo(cx + r * 0.5, cy - r * 0.5)
      .lineTo(cx + r * 0.5, cy + r * 0.15)
      .lineWidth(size * 0.15)
      .lineCap("round")
      .lineJoin("round")
      .strokeColor(color)
      .stroke();
  }
  doc.restore();
}

function drawLegend(l: Layout, w: Writer, top: number): void {
  let x = RIGHT;
  for (const state of [...STACK_ORDER].reverse()) {
    const label = STATE_LABEL[state];
    const tw = w.width(label, { size: 7.5 });
    x -= tw;
    w.line(label, x, top, { size: 7.5, color: MUTED });
    x -= 11;
    drawGlyph(l.doc, state, x, top + 1.3, 7);
    x -= 12;
  }
}

/** A clean top for a count axis: 1, 2, 5 or 10 × a power of ten (lib/report-dashboard's niceCeiling). */
function niceCeiling(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

function drawStackedColumns(
  l: Layout,
  w: Writer,
  buckets: Bucket[],
  labelEvery: (i: number, n: number) => boolean,
  plotH = 110,
): void {
  const axisW = 26;
  const x0 = LEFT + axisW;
  const plotW = WIDTH - axisW;
  const top = l.y;
  const base = top + plotH;
  const max = niceCeiling(Math.max(0, ...buckets.map((b) => b.outgoing + b.answered + b.missed)));

  // Recessive hairlines at top, middle and a stronger baseline.
  for (const [frac, color] of [
    [1, RULE],
    [0.5, RULE],
    [0, RULE_STRONG],
  ] as const) {
    const y = base - plotH * frac;
    l.doc.moveTo(x0, y).lineTo(RIGHT, y).lineWidth(frac === 0 ? 0.75 : 0.5).strokeColor(color).stroke();
    const tick = frac === 0.5 && max % 2 !== 0 ? "" : formatCount(max * frac);
    if (tick) w.line(tick, LEFT, y - 4, { size: 6.8, color: SUBTLE, width: axisW - 5, align: "right" });
  }

  const n = Math.max(1, buckets.length);
  const slot = plotW / n;
  const colW = Math.min(16, Math.max(1, slot * 0.72));
  const gap = colW >= 4 ? 0.9 : 0; // the surface gap between stacked segments

  buckets.forEach((b, i) => {
    const cx = x0 + slot * i + (slot - colW) / 2;
    let y = base;
    const segments = STACK_ORDER.map((s) => ({ state: s, value: b[s] })).filter((s) => s.value > 0);
    segments.forEach((seg, j) => {
      const h = (seg.value / max) * plotH;
      const isTop = j === segments.length - 1;
      const drawH = Math.max(0.6, h - (isTop ? 0 : gap));
      const yTop = y - h;
      l.doc.fillColor(STATE[seg.state]);
      if (isTop && colW >= 4 && drawH > 2) {
        // Rounded data end, square at the baseline.
        const rad = Math.min(1.8, drawH / 2);
        l.doc
          .moveTo(cx, yTop + drawH)
          .lineTo(cx, yTop + rad)
          .quadraticCurveTo(cx, yTop, cx + rad, yTop)
          .lineTo(cx + colW - rad, yTop)
          .quadraticCurveTo(cx + colW, yTop, cx + colW, yTop + rad)
          .lineTo(cx + colW, yTop + drawH)
          .closePath()
          .fill();
      } else {
        l.doc.rect(cx, yTop + (isTop ? 0 : gap), colW, drawH).fill();
      }
      y -= h;
    });
    if (labelEvery(i, n)) {
      w.line(b.label, x0 + slot * i - 20 + slot / 2, base + 4, { size: 6.8, color: SUBTLE, width: 40, align: "center" });
    }
  });
  l.y = base + 16;
}

function drawVolume(l: Layout, w: Writer, r: CallInsightsReport): void {
  // Per day up to a quarter, per week after - the shared rule, so the page and
  // this file cannot bucket the same report differently.
  const series = volumeSeries(r.daily);
  const weekly = series.unit === "week";
  const buckets: Bucket[] = series.buckets.map((b) => ({
    label: formatReportDate(b.start, false),
    outgoing: b.outgoing,
    answered: b.answered,
    missed: b.missed,
  }));
  // A short last week draws as a sudden drop in volume; say so rather than let
  // the reader find a collapse that did not happen.
  const partial = series.partialDays;
  l.section(
    "Call volume",
    weekly
      ? `Calls per week, by what happened${partial ? ` · the last column covers only ${partial} day${partial === 1 ? "" : "s"}` : ""}`
      : "Calls per day, by what happened",
    150,
  );
  drawLegend(l, w, l.y - 34);
  const n = buckets.length;
  // Evenly spaced labels only - forcing the last one in as well is how two
  // dates end up printed on top of each other.
  const every = n <= 10 ? 1 : n <= 31 ? Math.ceil(n / 8) : Math.ceil(n / 7);
  drawStackedColumns(l, w, buckets, (i) => i % every === 0);
}

function drawHours(l: Layout, w: Writer, r: CallInsightsReport): void {
  const buckets: Bucket[] = r.hourly.map((h) => ({
    label: `${h.hour % 12 === 0 ? 12 : h.hour % 12} ${h.hour < 12 ? "AM" : "PM"}`,
    outgoing: h.outgoing,
    answered: h.answered,
    missed: h.missed,
  }));
  l.section("When calls happen", `By hour of the day, ${r.org.timezone} · the whole period combined`, 140);
  drawLegend(l, w, l.y - 34);
  drawStackedColumns(l, w, buckets, (i) => i % 3 === 0, 90);

  const busiest = [...r.hourly].sort(
    (a, b) => b.outgoing + b.answered + b.missed - (a.outgoing + a.answered + a.missed) || a.hour - b.hour,
  )[0];
  const peakMissed = [...r.hourly].sort((a, b) => b.missed - a.missed || a.hour - b.hour)[0];
  const notes: string[] = [];
  if (busiest && busiest.outgoing + busiest.answered + busiest.missed > 0) {
    notes.push(`Busiest hour: ${formatHourSlot(busiest.hour)} (${formatCount(busiest.outgoing + busiest.answered + busiest.missed)} calls).`);
  }
  if (peakMissed && peakMissed.missed > 0) {
    notes.push(`Most missed calls: ${formatHourSlot(peakMissed.hour)} (${formatCount(peakMissed.missed)}).`);
  }
  if (notes.length) {
    w.line(notes.join("   "), LEFT + 26, l.y, { size: 8, color: MUTED, width: WIDTH - 26 });
    l.y += 14;
  }
}

// ── Horizontal bar lists (neutral ink: none of these are states) ─────────────

interface BarRow {
  label: string;
  count: number;
}

function barListHeight(rows: BarRow[]): number {
  return rows.length * 17;
}

function drawBarList(
  l: Layout,
  w: Writer,
  rows: BarRow[],
  x: number,
  top: number,
  width: number,
  denominator: number,
  labelW = 96,
): number {
  const valueW = 64;
  const barX = x + labelW + 6;
  const barW = Math.max(10, width - labelW - valueW - 12);
  const max = Math.max(1, ...rows.map((r) => r.count));
  rows.forEach((row, i) => {
    const y = top + i * 17;
    w.line(row.label, x, y + 1, { size: 8, width: labelW });
    l.doc.rect(barX, y + 3.5, barW, 6).fillColor(WASH).fill();
    if (row.count > 0) {
      const bw = Math.max(1.5, (row.count / max) * barW);
      l.doc.roundedRect(barX, y + 3.5, bw, 6, Math.min(1.5, bw / 2)).fillColor(BAR).fill();
    }
    const share = formatShare(ratio(row.count, denominator));
    w.line(`${formatCount(row.count)}  ${share}`, barX + barW + 6, y + 1, {
      size: 8,
      color: MUTED,
      width: valueW,
      align: "right",
    });
  });
  return rows.length * 17;
}

function drawConversationRead(l: Layout, w: Writer, r: CallInsightsReport): void {
  const c = r.current;
  const colW = (WIDTH - 24) / 2;
  const sentiment = r.sentiment.map((s) => ({ label: sentimentLabel(s.key), count: s.count }));
  const outcomes = r.outcomes.map((o) => ({ label: outcomeLabel(o.key), count: o.count }));
  const h = Math.max(barListHeight(sentiment), barListHeight(outcomes)) + 16;

  l.section(
    "What the calls were about",
    c.analyzed === 0
      ? "No call in this period has an AI read yet."
      : `From the AI read of ${formatCount(c.analyzed)} of ${formatCount(c.total)} calls (${formatShare(ratio(c.analyzed, c.total))}); shares are of analysed calls`,
    h,
  );
  if (c.analyzed > 0) {
    w.line("Sentiment", LEFT, l.y, { size: 8.5, weight: "bold" });
    w.line("Result of the call", LEFT + colW + 24, l.y, { size: 8.5, weight: "bold" });
    l.y += 15;
    drawBarList(l, w, sentiment, LEFT, l.y, colW, c.analyzed, 70);
    drawBarList(l, w, outcomes, LEFT + colW + 24, l.y, colW, c.analyzed, 100);
    l.y += h - 16;
  }

  // Human verdicts, kept apart from the machine's.
  const dispositions = r.dispositions.rows.map((d) => ({ label: d.label, count: d.count }));
  const dispH = dispositions.length ? barListHeight(dispositions) + 30 : 28;
  l.ensure(dispH + 10);
  l.y += 8;
  w.line("Recorded dispositions", LEFT, l.y, { size: 8.5, weight: "bold" });
  w.line(
    `What your team marked each call as · ${formatCount(r.dispositions.unset)} call${r.dispositions.unset === 1 ? "" : "s"} with none recorded`,
    LEFT + 118,
    l.y + 0.6,
    { size: 7.5, color: MUTED, width: WIDTH - 118 },
  );
  l.y += 15;
  if (dispositions.length) {
    l.y += drawBarList(l, w, dispositions, LEFT, l.y, WIDTH, c.total, 140);
  } else {
    w.line("No call was given a disposition in this period.", LEFT, l.y, { size: 8, color: MUTED });
    l.y += 14;
  }

  // Top intents: free text, so a ranked list rather than a chart.
  if (r.intents.rows.length) {
    const rows = r.intents.rows;
    l.ensure(28 + rows.length * 14);
    l.y += 8;
    w.line("Most common reasons for calling", LEFT, l.y, { size: 8.5, weight: "bold" });
    w.line(`${formatCount(r.intents.distinct)} distinct reasons in total`, LEFT + 170, l.y + 0.6, {
      size: 7.5,
      color: MUTED,
      width: WIDTH - 170,
    });
    l.y += 15;
    rows.forEach((row, i) => {
      w.line(`${i + 1}.`, LEFT, l.y, { size: 8, color: SUBTLE });
      w.line(row.label, LEFT + 14, l.y, { size: 8, width: WIDTH - 90 });
      w.line(`${formatCount(row.count)} call${row.count === 1 ? "" : "s"}`, RIGHT - 70, l.y, {
        size: 8,
        color: MUTED,
        width: 70,
        align: "right",
      });
      l.y += 14;
    });
  }
}

function drawQuality(l: Layout, w: Writer, r: CallInsightsReport): void {
  const q = r.quality;
  const colW = (WIDTH - 24) / 2;
  const rightX = LEFT + colW + 24;
  const tenth = (v: number | null) => (v === null ? "–" : `${v.toFixed(1).replace(/\.0$/, "")} / 10`);
  const facts: Array<[string, string, string]> = [
    ["Script adherence", tenth(q.criteria.scriptAdherence), `${formatCount(q.criteria.sample)} calls`],
    ["Professionalism", tenth(q.criteria.professionalism), ""],
    ["Conversion signal", tenth(q.criteria.conversionSignal), ""],
    [
      "Consent disclosed",
      q.criteria.consentDisclosedPct === null ? "–" : `${Math.round(q.criteria.consentDisclosedPct)}%`,
      "",
    ],
    [
      "Agent talk share",
      formatShare(r.talk.agentShare),
      r.talk.sample ? `${formatCount(r.talk.sample)} two-speaker calls` : "needs diarized calls",
    ],
    [
      "Interruptions per call",
      r.talk.interruptions === null ? "–" : r.talk.interruptions.toFixed(1).replace(/\.0$/, ""),
      "",
    ],
    [
      "SOP adherence",
      r.sop.adherence === null ? "–" : `${r.sop.adherence}%`,
      r.sop.scored ? `${formatCount(r.sop.scored)} calls scored` : "no SOP scoring",
    ],
  ];
  const bands = [
    { label: "Strong (70–100)", count: q.bands.strong },
    { label: "Fair (40–69)", count: q.bands.fair },
    { label: "Weak (0–39)", count: q.bands.weak },
  ];
  const h = Math.max(30 + barListHeight(bands), facts.length * 15 + 16);
  l.section(
    "Call quality & coaching",
    q.scored === 0
      ? "No call in this period has a quality score."
      : `Automatic quality score on ${formatCount(q.scored)} calls · average ${q.average === null ? "–" : Math.round(q.average)} / 100`,
    h,
  );
  const top = l.y;
  w.line("Quality score", LEFT, top, { size: 8.5, weight: "bold" });
  drawBarList(l, w, bands, LEFT, top + 15, colW, q.scored, 86);

  w.line("Criteria & talk", rightX, top, { size: 8.5, weight: "bold" });
  facts.forEach(([label, value, note], i) => {
    const y = top + 15 + i * 15;
    w.line(label, rightX, y, { size: 8, width: 110 });
    w.line(value, rightX + 112, y, { size: 8, weight: "bold", width: 50 });
    if (note) w.line(note, rightX + 164, y + 0.5, { size: 7, color: SUBTLE, width: colW - 164 });
    if (i < facts.length - 1) {
      l.doc
        .moveTo(rightX, y + 12.5)
        .lineTo(rightX + colW, y + 12.5)
        .lineWidth(0.4)
        .strokeColor(RULE)
        .stroke();
    }
  });
  l.y = top + h;
}

function drawRisk(l: Layout, w: Writer, r: CallInsightsReport): void {
  if (r.risk.calls === 0 && r.risk.categories.length === 0) return;
  const rows = r.risk.categories;
  l.section(
    "Escalation risk",
    `${formatCount(r.risk.calls)} call${r.risk.calls === 1 ? " was" : "s were"} flagged for a manager's attention · categories as the analysis named them`,
    rows.length * 15 + 18,
  );
  const cols = [
    { label: "Category", x: LEFT, w: WIDTH - 180, align: "left" as const },
    { label: "Calls", x: RIGHT - 170, w: 80, align: "right" as const },
    { label: "High severity", x: RIGHT - 80, w: 80, align: "right" as const },
  ];
  for (const col of cols) w.line(col.label, col.x, l.y, { size: 7.5, color: MUTED, width: col.w, align: col.align });
  l.y += 13;
  l.rule();
  l.y += 4;
  for (const row of rows) {
    const cells = [row.label, formatCount(row.calls), formatCount(row.high)];
    cells.forEach((cell, i) => w.line(cell, cols[i].x, l.y, { size: 8, width: cols[i].w, align: cols[i].align }));
    l.y += 15;
  }
}

function drawPeople(l: Layout, w: Writer, r: CallInsightsReport): void {
  const people = r.people;
  const cols: Array<{ label: string; w: number; value: (p: CallInsightsReport["people"][number]) => string }> = [
    { label: "Telecaller", w: 124, value: (p) => p.name },
    { label: "Calls", w: 40, value: (p) => formatCount(p.calls) },
    { label: "Out", w: 36, value: (p) => formatCount(p.outgoing) },
    { label: "Answered", w: 46, value: (p) => formatCount(p.answered) },
    { label: "Missed", w: 38, value: (p) => formatCount(p.missed) },
    { label: "Connect", w: 42, value: (p) => formatShare(ratio(p.connected, p.calls)) },
    { label: "Talk time", w: 50, value: (p) => formatTalkTime(p.talkSeconds) },
    { label: "Quality", w: 40, value: (p) => (p.avgQuality === null ? "–" : String(Math.round(p.avgQuality))) },
    { label: "Positive", w: 44, value: (p) => formatShare(ratio(p.positive, p.analyzed)) },
    { label: "Risk", w: 0, value: (p) => formatCount(p.riskCalls) },
  ];
  const fixed = cols.reduce((s, c) => s + c.w, 0);
  cols[cols.length - 1].w = WIDTH - fixed;

  l.section(
    "Team",
    people.length
      ? "Per telecaller, on who made each call at the time - a handset later handed to someone else keeps its history"
      : "No calls in this period.",
    people.length ? 40 : 0,
  );
  if (!people.length) return;

  const header = () => {
    let x = LEFT;
    cols.forEach((col, i) => {
      w.line(col.label, x, l.y, { size: 7.5, color: MUTED, width: col.w - (i === 0 ? 6 : 0), align: i === 0 ? "left" : "right" });
      x += col.w;
    });
    l.y += 13;
    l.rule(RULE_STRONG, 0.6);
    l.y += 4;
  };
  header();
  people.forEach((p, idx) => {
    if (l.y + 15 > BOTTOM) {
      l.newPage();
      w.line("Team (continued)", LEFT, l.y, { size: 9, weight: "bold" });
      l.y += 16;
      header();
    }
    let x = LEFT;
    cols.forEach((col, i) => {
      w.line(col.value(p), x, l.y, {
        size: 8,
        color: i === 0 && !p.telecallerId ? MUTED : INK,
        width: col.w - (i === 0 ? 6 : 0),
        align: i === 0 ? "left" : "right",
      });
      x += col.w;
    });
    l.y += 12;
    if (idx < people.length - 1) {
      l.doc.moveTo(LEFT, l.y).lineTo(RIGHT, l.y).lineWidth(0.4).strokeColor(RULE).stroke();
    }
    l.y += 3.5;
  });
}

function drawAttention(l: Layout, w: Writer, r: CallInsightsReport): void {
  const calls = r.attention;
  const summaryStyle = { size: 8, color: MUTED, leading: 11.5, maxLines: 3 };
  const blockHeight = (call: CallInsightsReport["attention"][number]) =>
    13 + 13 + 12 + (call.summary ? w.paragraphHeight(call.summary, WIDTH - 10, summaryStyle) : 0) + 12;
  l.section(
    "Calls worth a look",
    calls.length
      ? "Flagged for escalation risk, read as negative, or scored below 40 - highest risk first. Summaries are the AI's, not quotes."
      : "No call in this period was flagged, read as negative, or scored below 40.",
    // Keep the heading with its first call, measured rather than guessed.
    calls.length ? blockHeight(calls[0]) : 0,
  );
  const tz = r.org.timezone;
  for (const call of calls) {
    const meta = [
      formatCallTime(call.startedAt, tz),
      call.telecaller ?? "Not attributed",
      call.contact,
      `${call.direction === "outgoing" ? "Outgoing" : "Incoming"}, ${formatCallLength(call.durationS)}`,
    ].join("  ·  ");
    const facts = [
      call.outcome ? `Result: ${outcomeLabel(call.outcome)}` : null,
      call.sentiment ? `Feeling: ${sentimentLabel(call.sentiment)}` : null,
      call.quality !== null ? `Quality ${Math.round(call.quality)}/100` : null,
      call.riskCategories.length ? `Flags: ${call.riskCategories.map((c) => c.replace(/_/g, " ")).join(", ")}` : null,
      call.leadTitle ? `Lead: ${call.leadTitle}` : null,
    ].filter(Boolean) as string[];
    l.ensure(blockHeight(call));
    w.line(call.reasons.join(" · ") || "Needs review", LEFT, l.y, { size: 8.5, weight: "bold", width: WIDTH });
    l.y += 13;
    w.line(meta, LEFT, l.y, { size: 8, width: WIDTH });
    l.y += 13;
    if (facts.length) {
      w.line(facts.join("   "), LEFT, l.y, { size: 7.5, color: MUTED, width: WIDTH });
      l.y += 12;
    }
    if (call.summary) l.y += w.paragraph(call.summary, LEFT + 10, l.y + 1, WIDTH - 10, summaryStyle);
    l.y += 5;
    l.rule();
    l.y += 7;
  }
}

function drawNotes(l: Layout, w: Writer, r: CallInsightsReport, includeCalls: boolean): void {
  const notes = [
    "Missed = an incoming call with no talk time. Answered = an incoming call with talk time. Connect rate = calls with talk time ÷ all calls.",
    "Calls that could not be processed still count as calls; they have no AI read. Sentiment, result, reasons, quality and risk come from the automatic analysis of each transcript, so their shares use analysed calls as the base.",
    "Quality is scored 0–100 per call; its criteria 0–10. Talk share and interruptions need recordings with both speakers separated.",
    `Changes compare with the ${formatCount(r.range.days)} days immediately before this range (${formatReportRange(r.previousRange.from, r.previousRange.to)}). Days and hours are in ${r.org.timezone}.`,
    "This report never contains call transcripts or quoted call content.",
  ];
  if (!includeCalls) notes.push("Individual calls were left out of this copy at the request of whoever downloaded it.");
  const style = { size: 7.5, color: MUTED, leading: 10.5 };
  const heights = notes.map((n) => w.paragraphHeight(n, WIDTH - 10, style));
  l.section("About these figures", null, heights[0] ?? 0);
  notes.forEach((note, i) => {
    l.ensure(heights[i] + 3);
    w.line("–", LEFT, l.y, { size: 7.5, color: SUBTLE });
    l.y += w.paragraph(note, LEFT + 10, l.y, WIDTH - 10, style) + 3;
  });
}

function drawFooters(doc: PDFKit.PDFDocument, w: Writer, r: CallInsightsReport, rangeText: string): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = PAGE_H - 36;
    doc.moveTo(LEFT, y - 6).lineTo(RIGHT, y - 6).lineWidth(0.5).strokeColor(RULE).stroke();
    w.line(`${r.org.name}  ·  Call insights  ·  ${rangeText}`, LEFT, y, { size: 7, color: SUBTLE, width: WIDTH - 80 });
    w.line(`Page ${i + 1} of ${range.count}`, RIGHT - 80, y, { size: 7, color: SUBTLE, width: 80, align: "right" });
  }
}

/** Exported for the spec: the tile row the PDF leads with. */
export const __test = { kpiTiles, formatCallTime, formatGenerated };

export type { CallInsightsTotals };
