import { z } from "zod";

/**
 * Per-tenant white-label branding - `organizations.branding` (migration 0065).
 *
 * Pure by design (no db, no fetch, no node builtins) for the same reason
 * leads.ts is: the API validates a PATCH with this schema, the console builds
 * its form from the same field list, and the owner layout turns the colours
 * into CSS custom properties. One definition, three consumers - a field the
 * API would reject can never appear in the form.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The shape used to be written out three times by hand - a Zod object in
 * tenancy.controller.ts, `BrandingView` in branding-client.tsx and
 * `BrandingPatch` in the console's actions.ts - and they had already drifted.
 * That is the drift the shared package exists to prevent, and branding was the
 * one tenant-config surface still outside it.
 *
 * ── WHAT `loginBackgroundUrl` WAS ───────────────────────────────────────────
 *
 * An eighth field, dropped here. Every tenant signs in at the SAME address -
 * `<origin>/login`, the one URL sign-in-link.tsx hands out, with no subdomain
 * and no org in the path - so the sign-in screen has no tenant to look branding
 * up for. It was a control that could never do anything when saved.
 *
 * Dropping it from the schema does not delete anything: PATCH merges into the
 * jsonb (`branding || $2`), so a tenant who set it keeps the key, and Zod
 * strips it on read. If per-tenant sign-in URLs ever exist, the field comes
 * back and the stored values are still there.
 */

const HEX = /^#[0-9a-fA-F]{6}$/u;

const HexColor = z.string().regex(HEX, "expected a hex colour like #2563eb");
const AssetUrl = z.string().url().max(500);

/**
 * The seven fields.
 *
 * URLs rather than uploads for the images, consistent with the original
 * `logoUrl`: there is no asset pipeline in this console and inventing one for
 * a favicon would be the tail wagging the dog. The console says so beside each
 * field rather than offering a file picker that would not work.
 */
export const Branding = z.object({
  logoUrl: AssetUrl.nullish(),
  faviconUrl: AssetUrl.nullish(),
  bannerUrl: AssetUrl.nullish(),
  primaryColor: HexColor.nullish(),
  secondaryColor: HexColor.nullish(),
  appBackgroundColor: HexColor.nullish(),
  browserTitle: z.string().max(120).nullish(),
});
export type Branding = z.infer<typeof Branding>;

/** Same tolerance as parseLeadStages: bad config falls back, never throws. A
 *  malformed branding blob must not take a tenant's whole console down - they
 *  would lose the product over a colour. */
export function parseBranding(raw: unknown): Branding {
  const parsed = Branding.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

// ── colour maths ────────────────────────────────────────────────────────────
//
// theme.css states its contract as "every pair below was computed, not
// eyeballed (WCAG 2.1 relative luminance)". A tenant hex arrives at runtime and
// cannot be checked by hand, so the same arithmetic runs here instead - that is
// the only way an arbitrary brand colour can enter that token set without
// quietly voiding the contrast the whole system is documented on.

/** theme.css --color-text. The ink every light surface is measured against. */
export const INK = "#171717";
export const PAPER = "#ffffff";

/** theme.css --color-bg in dark mode. The other ground a filled card sits on. */
export const DARK_PAGE = "#0a0a0a";

/** theme.css's stock gradient stops - the fallback ends of the ramp. */
export const STOCK_BRAND_FROM = "#00b4f0";
export const STOCK_BRAND_TO = "#7b2ff7";

/** theme.css's --color-kpi trio - the default when a tenant has chosen nothing. */
export const STOCK_KPI = "#c2410c";
export const STOCK_KPI_FG = "#ffffff";
export const STOCK_KPI_HAIRLINE = "#fbd9c6";

export function parseHex(hex: string): [number, number, number] | null {
  const value = hex.trim();
  if (!HEX.test(value)) return null;
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

/** sRGB 0-255 channel to its linear-light value (WCAG 2.1). */
function linearize(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
}

/** WCAG contrast ratio, 1..21. Null if either colour is not a hex triplet. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function byteToHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/** Linear blend in sRGB space. `amount` is how far to travel from -> to. */
export function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  const t = Math.max(0, Math.min(1, amount));
  return `#${byteToHex(a[0] + (b[0] - a[0]) * t)}${byteToHex(a[1] + (b[1] - a[1]) * t)}${byteToHex(
    a[2] + (b[2] - a[2]) * t,
  )}`;
}

/**
 * The label colour to put ON a fill of `background` - whichever of paper or ink
 * actually holds more contrast, rather than the stock `--color-accent-fg`
 * (#ffffff), which is only correct while the accent stays a mid-blue. A tenant
 * with a yellow or lime brand colour gets ink; the stock token would have given
 * them white-on-yellow.
 */
export function readableOn(background: string): string {
  const onPaper = contrastRatio(background, PAPER);
  const onInk = contrastRatio(background, INK);
  if (onPaper === null || onInk === null) return PAPER;
  return onPaper >= onInk ? PAPER : INK;
}

/**
 * The hover shade for a fill. Darker by default; a brand colour that is
 * already near-black has nowhere darker to go and its hover would be
 * imperceptible, so that end of the range lightens instead.
 */
export function hoverShade(hex: string): string {
  const l = relativeLuminance(hex);
  if (l === null) return hex;
  return l < 0.06 ? mix(hex, PAPER, 0.18) : mix(hex, "#000000", 0.15);
}

/**
 * A text colour that clears AA (4.5:1) on the given tinted background, walking
 * the seed darker until it does. theme.css derives `--color-accent-text` the
 * same way by hand (#1e40af on #eff6ff, "8.01:1"); this is that step done for
 * a colour nobody could check in advance.
 */
export function accentTextOn(background: string, seed: string): string {
  let candidate = seed;
  for (let i = 0; i < 24; i += 1) {
    const ratio = contrastRatio(candidate, background);
    if (ratio !== null && ratio >= 4.5) return candidate;
    candidate = mix(candidate, "#000000", 0.12);
  }
  return INK;
}

/* ── The KPI surface ────────────────────────────────────────────────────────
 *
 * The dashboard's headline row is a band of SOLID cards - the one filled
 * surface in the console - and it used to be a fixed orange (#C2410C) picked
 * by hand precisely because white 12px text clears 4.5:1 on it. Handing that
 * fill to a tenant means handing over the one number the whole tile depends on,
 * to somebody choosing a colour from a brand guide with no idea that a KPI
 * label will be printed on it.
 *
 * So the tenant chooses the HUE and this chooses the shade. Three constraints,
 * all of which must hold at once:
 *
 *   1. LEGIBLE. Either paper or ink must clear 4.5:1 on the fill. Not 3:1 -
 *      the tile's eyebrow and its context line are 12px, which WCAG 1.4.3
 *      governs at the full ratio, and those two lines are the "contextual data
 *      display" the tile exists for. The big number alone would qualify as
 *      large text; the sentence under it would not.
 *
 *   2. VISIBLE ON BOTH GROUNDS. `--color-kpi` is deliberately constant across
 *      light and dark (see theme.css), so one fill has to separate from a white
 *      page AND from a near-black one. A tenant whose brand is #FFFFFF would
 *      otherwise get an invisible row of cards in light mode, and one whose
 *      brand is #000000 would get the same in dark. 1.6:1 against each is the
 *      floor - this is a decorative container edge, not a control boundary, so
 *      WCAG 1.4.11's 3:1 does not apply; the requirement is only that a reader
 *      can see where the card is.
 *
 *   3. STILL THEIRS. Every adjustment is a straight blend toward white or
 *      black, which moves lightness and leaves hue where it was. A tenant who
 *      picks a mid-red gets a slightly deeper red, not a different colour.
 *
 * ── THE DEAD ZONE ─────────────────────────────────────────────────────────
 *
 * There is a band of mid-tones - roughly 0.183 < L < 0.226 - where NEITHER
 * white nor near-black reaches 4.5:1. A #808080 grey is in it, and so is a
 * pure #FF0000. There is no foreground that fixes those, which is why this
 * moves the FILL rather than searching harder for a label colour: the only way
 * out is out, and the nearer edge is the one that changes the tenant's colour
 * least.
 */

const KPI_LABEL_CONTRAST = 4.5;
const KPI_PAGE_SEPARATION = 1.6;

export interface KpiSurface {
  /** The tile's fill. */
  fill: string;
  /** Paper or ink - whichever the fill can carry at 4.5:1. */
  fg: string;
  /** The divider rule and icon tint inside the tile. ~3:1 on the fill. */
  hairline: string;
  /** True when the seed had to be shifted to satisfy the constraints above. */
  adjusted: boolean;
}

/** Does this fill satisfy all three constraints? */
function usableKpiFill(fill: string): boolean {
  const onPaper = contrastRatio(fill, PAPER);
  const onInk = contrastRatio(fill, INK);
  const onDarkPage = contrastRatio(fill, DARK_PAGE);
  if (onPaper === null || onInk === null || onDarkPage === null) return false;
  return (
    Math.max(onPaper, onInk) >= KPI_LABEL_CONTRAST &&
    // onPaper doubles as the separation from a white page: same two colours.
    onPaper >= KPI_PAGE_SEPARATION &&
    onDarkPage >= KPI_PAGE_SEPARATION
  );
}

/**
 * The KPI trio for a tenant's chosen hue.
 *
 * Iterative rather than solved algebraically, matching `accentTextOn` next
 * door and for the same reason: the target is a WCAG ratio, which is a
 * piecewise function of three gamma-corrected channels, and 6% blends
 * converging in under a dozen steps are easier to reason about than the
 * closed form - and impossible to get subtly wrong.
 */
export function kpiSurface(seed: string): KpiSurface {
  const luminance = relativeLuminance(seed);
  if (luminance === null) {
    return {
      fill: STOCK_KPI,
      fg: STOCK_KPI_FG,
      hairline: STOCK_KPI_HAIRLINE,
      adjusted: false,
    };
  }

  let fill = seed;
  let adjusted = false;

  if (!usableKpiFill(fill)) {
    // ONE direction, chosen once from the seed, then walked. Deciding per-step
    // would let a fill oscillate across the dead zone and never settle.
    //
    // The three cases, in the order they have to be tested. The visibility
    // failures come first because they are unambiguous - there is exactly one
    // way out of each - and the dead zone is only reachable once neither
    // applies.
    //
    // Thresholds, for anyone checking the arithmetic (L is relative luminance;
    // INK is 0.00859, DARK_PAGE is 0.00303):
    //   invisible on the dark page   L < 0.0349
    //   invisible on the light page  L > 0.6063
    //   dead zone (no 4.5:1 label)   0.1833 < L < 0.2137, midpoint 0.1985
    const tooDarkToSee = (contrastRatio(seed, DARK_PAGE) ?? 0) < KPI_PAGE_SEPARATION;
    const tooLightToSee = (contrastRatio(seed, PAPER) ?? 0) < KPI_PAGE_SEPARATION;
    const target = tooDarkToSee
      ? PAPER
      : tooLightToSee
        ? "#000000"
        : // In the dead zone: leave by the nearer edge, so the tenant's colour
          // moves as little as possible. Up, and ink becomes the label; down,
          // and paper does.
          luminance > 0.1985
          ? PAPER
          : "#000000";

    for (let i = 0; i < 24 && !usableKpiFill(fill); i += 1) {
      fill = mix(fill, target, 0.06);
    }
    adjusted = true;

    // Belt and braces. Every seed reachable through the schema is a valid hex
    // and converges well inside 24 steps, but a fill that failed here would be
    // an unreadable dashboard for a whole tenant - so it falls back to the
    // colour the product shipped with rather than to whatever the loop left.
    if (!usableKpiFill(fill)) {
      return {
        fill: STOCK_KPI,
        fg: STOCK_KPI_FG,
        hairline: STOCK_KPI_HAIRLINE,
        adjusted: true,
      };
    }
  }

  const fg = readableOn(fill);

  // The hairline is the tile's divider and its icon tint - non-text, so 3:1 is
  // the right floor (WCAG 1.4.11). Walking from the fill TOWARD the label keeps
  // it in the tile's own colour family instead of introducing a third hue, and
  // stopping at the first blend that clears 3:1 keeps it a rule rather than a
  // second line of full-contrast text.
  let hairline = fg;
  for (let t = 0.35; t <= 0.85; t += 0.05) {
    const candidate = mix(fill, fg, t);
    const ratio = contrastRatio(candidate, fill);
    if (ratio !== null && ratio >= 3) {
      hairline = candidate;
      break;
    }
  }

  return { fill, fg, hairline, adjusted };
}

/**
 * Is this safe to paint the console's page background with?
 *
 * `appBackgroundColor` is documented in the console as "the page behind the
 * console" - a tint, like its own #f8fafc placeholder. Console text sits
 * DIRECTLY on that background (page headings, table rows, muted labels), and
 * those use `--color-text`, which the tenant is not choosing. So a dark hex
 * here would render the console's own body copy unreadable.
 *
 * Rather than cascade a whole replacement token set - which then collides with
 * theme.css's dark mode and with the white card surfaces that keep their own
 * ink - the background is simply refused unless it holds AA against that ink.
 * The console says the same thing next to the field, so this is a backstop for
 * a value that arrived some other way (the API, an older save), not the primary
 * way a user finds out.
 */
export function isUsableAppBackground(hex: string): boolean {
  const ratio = contrastRatio(hex, INK);
  return ratio !== null && ratio >= 4.5;
}

/**
 * The CSS custom properties one org's branding overrides, ready to spread onto
 * a `style` attribute.
 *
 * Returned as plain custom properties rather than a stylesheet because they are
 * set on ONE element - the owner console's root - and inherit from there.
 * `--brand-gradient` itself is not overridden: it is declared in theme.css as
 * `linear-gradient(115deg, var(--brand-from) …)`, and custom properties are
 * substituted where they are USED, so re-pointing the three stops re-colours
 * every consumer of the gradient (the primary Button, PageHeader, active nav
 * items, tabs, skeletons) without touching any of them.
 */
export function brandingCssVars(branding: Branding): Record<string, string> {
  const vars: Record<string, string> = {};

  const primary = branding.primaryColor?.trim();
  const secondary = branding.secondaryColor?.trim();
  const background = branding.appBackgroundColor?.trim();

  const hasPrimary = !!primary && HEX.test(primary);
  const hasSecondary = !!secondary && HEX.test(secondary);

  if (hasPrimary || hasSecondary) {
    // Both stops named: the gradient runs brand -> accent, which is what the
    // two fields are called in the console. Only one named: the ramp is that
    // one hue deepening, so it still reads as a gradient rather than snapping
    // to a flat fill on one end and the stock cyan/violet on the other.
    const from = hasPrimary ? (primary as string) : STOCK_BRAND_FROM;
    const to = hasSecondary
      ? (secondary as string)
      : hasPrimary
        ? mix(primary as string, "#000000", 0.28)
        : STOCK_BRAND_TO;

    vars["--brand-from"] = from;
    vars["--brand-mid"] = mix(from, to, 0.5);
    vars["--brand-to"] = to;
  }

  if (hasPrimary) {
    // The whole accent ramp, not just --color-accent. Overriding the fill alone
    // would leave `--color-accent-subtle` as theme.css's #eff6ff - a blue tint
    // behind a green brand colour - and `--color-accent-fg` as white, which is
    // wrong the moment a tenant picks a light hue.
    const accent = primary as string;
    const subtle = mix(accent, PAPER, 0.92);
    vars["--color-accent"] = accent;
    vars["--color-accent-hover"] = hoverShade(accent);
    vars["--color-accent-fg"] = readableOn(accent);
    vars["--color-accent-subtle"] = subtle;
    vars["--color-accent-text"] = accentTextOn(subtle, accent);
  }

  /*
   * ── THE KPI BAND ────────────────────────────────────────────────────────
   *
   * Seeded from the ACCENT where a tenant has set one, and only from the brand
   * colour otherwise.
   *
   * That ordering is the whole point, and it is not arbitrary. The console has
   * two registers: chrome (the rail, page headers, primary buttons, tabs),
   * which runs on `--color-accent` and the gradient, and the dashboard's
   * headline band, which is the one solid fill on the page. Shipping them in
   * the same colour would flatten the dashboard into a single wash, which is
   * exactly what the fixed orange existed to avoid - it was chosen to sit
   * AGAINST the blue chrome, not with it.
   *
   * So a tenant who has named two colours gets the same two-register layout in
   * their own palette, and a tenant who has named one gets a monochrome
   * console, which is the honest rendering of "I have one brand colour". The
   * branding page says which field drives which surface.
   */
  const kpiSeed = hasSecondary ? (secondary as string) : hasPrimary ? (primary as string) : null;
  if (kpiSeed) {
    // Never the raw hex. `kpiSurface` moves it only as far as it has to in
    // order to carry a 12px label and to be visible on both page grounds - see
    // its header for the three constraints and why a hue nobody has checked
    // cannot be trusted with a filled card.
    const kpi = kpiSurface(kpiSeed);
    vars["--color-kpi"] = kpi.fill;
    vars["--color-kpi-fg"] = kpi.fg;
    vars["--color-kpi-hairline"] = kpi.hairline;
  }

  if (background && HEX.test(background) && isUsableAppBackground(background)) {
    vars["--color-bg"] = background;
    // bg-subtle is the PageHeader's card ground - one step off the page, the
    // same relationship theme.css's own #fafafa has to its #ffffff.
    vars["--color-bg-subtle"] = mix(background, INK, 0.04);
  }

  return vars;
}

/**
 * The browser tab title for this org, or null to keep the product default.
 *
 * Used as the `title.template` root in the owner console's layout so the 38
 * pages under it contribute only their own name ("Contacts") and the tenant's
 * name is appended once, here. Those pages used to each hardcode "- Aura",
 * which made this field unimplementable no matter what the layout did.
 */
export function browserTitleFor(branding: Branding, fallback: string): string {
  const title = branding.browserTitle?.trim();
  return title && title.length > 0 ? title : fallback;
}
