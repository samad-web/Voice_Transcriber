import { describe, expect, it } from "vitest";

import {
  Branding,
  DARK_PAGE,
  INK,
  PAPER,
  STOCK_KPI,
  STOCK_KPI_FG,
  STOCK_KPI_HAIRLINE,
  accentTextOn,
  brandingCssVars,
  browserTitleFor,
  contrastRatio,
  hoverShade,
  isUsableAppBackground,
  kpiSurface,
  mix,
  parseBranding,
  parseHex,
  readableOn,
  relativeLuminance,
} from "./branding";

/**
 * The branding colour maths.
 *
 * theme.css's contract is "every pair was computed, not eyeballed (WCAG 2.1)".
 * A tenant hex arrives at runtime, so these functions are what upholds that
 * contract for colours nobody could check by hand - which makes their
 * arithmetic a correctness property, not a cosmetic one. The reference values
 * below are taken from theme.css's own documented ratios.
 */

describe("relativeLuminance / contrastRatio", () => {
  it("puts the anchors where WCAG does", () => {
    expect(relativeLuminance(PAPER)).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    // The extremes of the scale.
    expect(contrastRatio("#000000", PAPER)).toBeCloseTo(21, 4);
    expect(contrastRatio(PAPER, PAPER)).toBeCloseTo(1, 5);
  });

  it("reproduces the ratios theme.css documents for its own tokens", () => {
    // "--color-accent: #2563eb; /* 5.17:1 on bg */"
    expect(contrastRatio("#2563eb", PAPER)).toBeCloseTo(5.17, 1);
    // "--color-text-muted: #6b6b6b" - "4.89:1 on the hover surface" (#f5f5f5).
    expect(contrastRatio("#6b6b6b", "#f5f5f5")).toBeCloseTo(4.89, 1);
    // "--color-warning: #a16207 … #A16207 is 4.92:1".
    expect(contrastRatio("#a16207", PAPER)).toBeCloseTo(4.92, 1);
    // "--color-accent-text: #1e40af; /* 8.01:1 on --color-accent-subtle */"
    expect(contrastRatio("#1e40af", "#eff6ff")).toBeCloseTo(8.01, 1);
  });

  it("is order-independent and rejects non-hex input", () => {
    expect(contrastRatio("#2563eb", PAPER)).toBe(contrastRatio(PAPER, "#2563eb"));
    expect(contrastRatio("blue", PAPER)).toBeNull();
    expect(contrastRatio("#abc", PAPER)).toBeNull();
    expect(relativeLuminance("#12345")).toBeNull();
  });
});

describe("readableOn", () => {
  it("picks ink for light brand colours and paper for dark ones", () => {
    // The case the stock --color-accent-fg (#ffffff) gets wrong: white on
    // yellow is 1.07:1. This is the reason the token is computed at all.
    expect(readableOn("#ffff00")).toBe(INK);
    expect(readableOn("#84cc16")).toBe(INK);
    expect(readableOn("#2563eb")).toBe(PAPER);
    expect(readableOn("#0f172a")).toBe(PAPER);
  });

  it("always returns a label that clears AA on the fill it was chosen for", () => {
    for (const hex of ["#ffff00", "#84cc16", "#2563eb", "#0f172a", "#dc2626", "#00b4f0"]) {
      const ratio = contrastRatio(hex, readableOn(hex));
      expect([hex, (ratio ?? 0) >= 4.5]).toEqual([hex, true]);
    }
  });
});

describe("mix", () => {
  it("returns the endpoints at 0 and 1, and the midpoint at 0.5", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("clamps out-of-range amounts and passes bad input through", () => {
    expect(mix("#000000", "#ffffff", -3)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 9)).toBe("#ffffff");
    expect(mix("nope", "#ffffff", 0.5)).toBe("nope");
  });
});

describe("hoverShade", () => {
  it("darkens an ordinary brand colour", () => {
    const hovered = hoverShade("#2563eb");
    expect(relativeLuminance(hovered)!).toBeLessThan(relativeLuminance("#2563eb")!);
  });

  it("lightens a near-black one, which has nowhere darker to go", () => {
    // The bug this branch exists for: mixing #050505 toward black is a no-op,
    // so the hover state would be invisible.
    const hovered = hoverShade("#050505");
    expect(relativeLuminance(hovered)!).toBeGreaterThan(relativeLuminance("#050505")!);
  });
});

describe("accentTextOn", () => {
  it("walks the seed dark enough to clear AA on the tint", () => {
    const subtle = mix("#2563eb", PAPER, 0.92);
    const text = accentTextOn(subtle, "#2563eb");
    expect(contrastRatio(text, subtle)!).toBeGreaterThanOrEqual(4.5);
  });

  it("clears AA for every hue, including the light ones", () => {
    for (const hex of ["#ffff00", "#84cc16", "#00b4f0", "#dc2626", "#7b2ff7"]) {
      const subtle = mix(hex, PAPER, 0.92);
      const ratio = contrastRatio(accentTextOn(subtle, hex), subtle);
      expect([hex, (ratio ?? 0) >= 4.5]).toEqual([hex, true]);
    }
  });
});

describe("isUsableAppBackground", () => {
  it("accepts the tint the console offers as its own placeholder", () => {
    expect(isUsableAppBackground("#f8fafc")).toBe(true);
    expect(isUsableAppBackground(PAPER)).toBe(true);
  });

  it("refuses a background the console's own body ink cannot be read on", () => {
    // Console text sits directly on this colour using --color-text, which the
    // tenant is not choosing. Dark values here are what would blank a page.
    expect(isUsableAppBackground("#0f172a")).toBe(false);
    expect(isUsableAppBackground("#334155")).toBe(false);
  });
});

describe("Branding schema", () => {
  it("accepts the seven fields", () => {
    const parsed = Branding.safeParse({
      logoUrl: "https://cdn.example.com/logo.png",
      faviconUrl: "https://cdn.example.com/fav.png",
      bannerUrl: "https://cdn.example.com/banner.png",
      primaryColor: "#2563eb",
      secondaryColor: "#0f172a",
      appBackgroundColor: "#f8fafc",
      browserTitle: "Acme CRM",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a colour that is not a six-digit hex", () => {
    expect(Branding.safeParse({ primaryColor: "red" }).success).toBe(false);
    expect(Branding.safeParse({ primaryColor: "#abc" }).success).toBe(false);
  });

  it("rejects a non-URL image", () => {
    expect(Branding.safeParse({ logoUrl: "logo.png" }).success).toBe(false);
  });

  it("strips loginBackgroundUrl rather than failing on it", () => {
    // A tenant who set the retired field still has the key in their jsonb.
    // Reading their org must not 500, and must not resurrect the field.
    const parsed = parseBranding({
      logoUrl: "https://cdn.example.com/logo.png",
      loginBackgroundUrl: "https://cdn.example.com/bg.jpg",
    });
    expect(parsed.logoUrl).toBe("https://cdn.example.com/logo.png");
    expect("loginBackgroundUrl" in parsed).toBe(false);
  });
});

describe("parseBranding", () => {
  it("falls back to empty rather than throwing on junk", () => {
    // Same tolerance as parseLeadStages: a bad colour must not cost a tenant
    // their whole console.
    expect(parseBranding(null)).toEqual({});
    expect(parseBranding("nonsense")).toEqual({});
    expect(parseBranding({ primaryColor: "not-a-colour" })).toEqual({});
  });
});

describe("brandingCssVars", () => {
  it("returns nothing for an unconfigured org", () => {
    expect(brandingCssVars({})).toEqual({});
  });

  it("re-points the three gradient stops, not --brand-gradient itself", () => {
    // theme.css declares the gradient in terms of the stops, and custom
    // properties resolve where they are used - so moving the stops re-colours
    // every consumer without touching them.
    const vars = brandingCssVars({ primaryColor: "#2563eb", secondaryColor: "#0f172a" });
    expect(vars["--brand-from"]).toBe("#2563eb");
    expect(vars["--brand-to"]).toBe("#0f172a");
    expect(vars["--brand-mid"]).toBe(mix("#2563eb", "#0f172a", 0.5));
    expect(vars["--brand-gradient"]).toBeUndefined();
  });

  it("derives a full accent ramp, not just the fill", () => {
    // Overriding --color-accent alone would leave a blue tint (#eff6ff) behind
    // a green brand colour and a white label on a light one.
    const vars = brandingCssVars({ primaryColor: "#84cc16" });
    expect(vars["--color-accent"]).toBe("#84cc16");
    expect(vars["--color-accent-fg"]).toBe(INK);
    expect(contrastRatio(vars["--color-accent-text"]!, vars["--color-accent-subtle"]!)!)
      .toBeGreaterThanOrEqual(4.5);
  });

  it("deepens a single hue when only the brand colour is set", () => {
    const vars = brandingCssVars({ primaryColor: "#2563eb" });
    expect(vars["--brand-from"]).toBe("#2563eb");
    // Not the stock violet - that would read as a half-applied theme.
    expect(vars["--brand-to"]).not.toBe("#7b2ff7");
    expect(relativeLuminance(vars["--brand-to"]!)!).toBeLessThan(
      relativeLuminance("#2563eb")!,
    );
  });

  it("applies a usable page background and refuses an unreadable one", () => {
    expect(brandingCssVars({ appBackgroundColor: "#f8fafc" })["--color-bg"]).toBe("#f8fafc");
    // Would leave --color-text (#171717) at 1.5:1 on the page.
    expect(brandingCssVars({ appBackgroundColor: "#0f172a" })["--color-bg"]).toBeUndefined();
  });

  it("ignores images and the tab title - they are not CSS", () => {
    const vars = brandingCssVars({
      logoUrl: "https://cdn.example.com/logo.png",
      browserTitle: "Acme",
    });
    expect(vars).toEqual({});
  });
});

/**
 * The KPI surface derivation.
 *
 * This is the one place a tenant's own hex ends up as a FILL with text printed
 * on it, so it is the one place where "the tenant picked it" is not an answer
 * to "is it readable". Every assertion below is a property, checked against
 * the arithmetic, rather than a pinned hex - the exact shade the search lands
 * on is an implementation detail and pinning it would make the suite fail on a
 * step-size change that broke nothing.
 */
describe("kpiSurface", () => {
  /** Seeds spanning the whole problem: fine as-is, dead zone, both extremes. */
  const SEEDS = [
    "#2563eb", // stock blue - already fine
    "#c2410c", // the colour this replaced
    "#16a34a",
    "#7b2ff7",
    "#00b4f0",
    "#84cc16",
    "#facc15", // too light to see on a white page
    "#ff0000", // dead zone
    "#808080", // dead zone
    "#ffffff", // invisible in light mode
    "#000000", // invisible in dark mode
    "#0a0a0a",
    "#1e293b",
    "#f5f5f4",
  ];

  it("always produces a label that clears AA on the fill", () => {
    // 4.5:1, not 3:1: the tile's eyebrow and its context line are 12px, and
    // those two lines are the contextual data the tile exists to carry. A
    // large-text exemption would cover the big number and nothing else.
    for (const seed of SEEDS) {
      const { fill, fg } = kpiSurface(seed);
      expect([seed, (contrastRatio(fill, fg) ?? 0) >= 4.5]).toEqual([seed, true]);
    }
  });

  it("always stays visible against BOTH page grounds", () => {
    // --color-kpi is constant across light and dark by design, so one fill has
    // to separate from a white page and from a near-black one. Without this a
    // white brand colour is an invisible row of cards in light mode.
    for (const seed of SEEDS) {
      const { fill } = kpiSurface(seed);
      expect([seed, (contrastRatio(fill, PAPER) ?? 0) >= 1.6]).toEqual([seed, true]);
      expect([seed, (contrastRatio(fill, DARK_PAGE) ?? 0) >= 1.6]).toEqual([seed, true]);
    }
  });

  it("gives the hairline the 3:1 a non-text rule needs", () => {
    for (const seed of SEEDS) {
      const { fill, hairline } = kpiSurface(seed);
      expect([seed, (contrastRatio(hairline, fill) ?? 0) >= 3]).toEqual([seed, true]);
    }
  });

  it("leaves a colour that already works completely alone", () => {
    // The tenant chose it. Nudging a perfectly good hex would be the system
    // overriding a decision it had no reason to touch.
    for (const seed of ["#2563eb", "#c2410c", "#16a34a", "#7b2ff7"]) {
      expect([seed, kpiSurface(seed).fill]).toEqual([seed, seed]);
      expect([seed, kpiSurface(seed).adjusted]).toEqual([seed, false]);
    }
  });

  it("escapes the dead zone where NO label would have worked", () => {
    // Around L 0.183-0.214 neither white nor near-black reaches 4.5:1. Pure
    // red and mid grey both sit in it, and the only fix is to move the fill.
    const red = kpiSurface("#ff0000");
    expect(red.adjusted).toBe(true);
    expect(contrastRatio(red.fill, red.fg)!).toBeGreaterThanOrEqual(4.5);
    // Still red: every adjustment is a blend toward white or black, which
    // moves lightness and leaves the hue where the tenant put it.
    const [r, g, b] = parseHex(red.fill)!;
    expect([r > 200, g < 90, b < 90]).toEqual([true, true, true]);
  });

  it("darkens a colour too light to see on a white page", () => {
    const yellow = kpiSurface("#facc15");
    expect(yellow.adjusted).toBe(true);
    expect(relativeLuminance(yellow.fill)!).toBeLessThan(relativeLuminance("#facc15")!);
    // Still yellow - red and green high, blue low.
    const [r, g, b] = parseHex(yellow.fill)!;
    expect([r > 180, g > 140, b < 90]).toEqual([true, true, true]);
  });

  it("lightens a colour too dark to see on the dark-mode page", () => {
    // #1e293b is a plausible brand navy and sits at L 0.0296, under the 0.0349
    // floor - a card that would vanish into a #0a0a0a page.
    const navy = kpiSurface("#1e293b");
    expect(navy.adjusted).toBe(true);
    expect(relativeLuminance(navy.fill)!).toBeGreaterThan(relativeLuminance("#1e293b")!);
  });

  it("falls back to the shipped orange for a value that is not a colour", () => {
    // parseBranding would normally have refused this. If one arrives anyway,
    // a tenant gets the product default rather than an unstyled dashboard.
    expect(kpiSurface("not a hex")).toEqual({
      fill: STOCK_KPI,
      fg: STOCK_KPI_FG,
      hairline: STOCK_KPI_HAIRLINE,
      adjusted: false,
    });
  });
});

describe("brandingCssVars - the KPI band", () => {
  it("leaves the stock orange in place for an unbranded org", () => {
    // No token emitted at all, so theme.css's own --color-kpi stands. Emitting
    // the same value would work and would also mean every tenant's console
    // carried an inline override that does nothing.
    expect(brandingCssVars({})["--color-kpi"]).toBeUndefined();
    expect(brandingCssVars({ logoUrl: "https://x.example/l.png" })["--color-kpi"]).toBeUndefined();
  });

  it("seeds from the ACCENT when a tenant has set one", () => {
    // The two-register layout: chrome runs on the brand colour, the headline
    // band on the accent. Same relationship the fixed orange had to the stock
    // blue chrome.
    const vars = brandingCssVars({ primaryColor: "#2563eb", secondaryColor: "#c2410c" });
    expect(vars["--color-kpi"]).toBe("#c2410c");
    expect(vars["--color-accent"]).toBe("#2563eb");
  });

  it("falls back to the brand colour when there is no accent", () => {
    const vars = brandingCssVars({ primaryColor: "#7b2ff7" });
    expect(vars["--color-kpi"]).toBe("#7b2ff7");
  });

  it("emits the whole trio, never a fill on its own", () => {
    // A fill without its foreground would leave --color-kpi-fg at theme.css's
    // white - which is wrong the moment a tenant picks a light hue, and is
    // exactly the bug the accent ramp above already had to fix once.
    const vars = brandingCssVars({ primaryColor: "#facc15" });
    expect(vars["--color-kpi"]).toBeDefined();
    expect(vars["--color-kpi-fg"]).toBe(INK);
    expect(vars["--color-kpi-hairline"]).toBeDefined();
    expect(contrastRatio(vars["--color-kpi"]!, vars["--color-kpi-fg"]!)!).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("does not touch the four state hues", () => {
    // The functional colour rule (@aura/ui state.tsx) has to survive
    // white-labelling: red still means missed on every tenant's console, no
    // matter what they picked. Branding owns chrome and the KPI band; it does
    // not own the palette that encodes state.
    const vars = brandingCssVars({ primaryColor: "#16a34a", secondaryColor: "#dc2626" });
    for (const token of ["--color-danger", "--color-success", "--color-orange"]) {
      expect([token, vars[token]]).toEqual([token, undefined]);
    }
  });
});

describe("browserTitleFor", () => {
  it("prefers the tenant title and falls back on blank", () => {
    expect(browserTitleFor({ browserTitle: "Acme CRM" }, "Aura")).toBe("Acme CRM");
    expect(browserTitleFor({ browserTitle: "   " }, "Aura")).toBe("Aura");
    expect(browserTitleFor({}, "Aura")).toBe("Aura");
  });
});
