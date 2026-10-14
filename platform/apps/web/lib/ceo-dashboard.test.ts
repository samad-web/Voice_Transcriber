import { describe, expect, it } from "vitest";
import {
  activeCallers,
  bucketByGrain,
  donutArcs,
  donutWedges,
  driverSlices,
  effortPlot,
  forecast,
  funnelInsight,
  funnelSteps,
  pace,
  paceInsight,
  parseGrain,
  parseSeries,
  perDayText,
  rankAlerts,
  revenuePerCall,
  scenarios,
  sliceShare,
  yieldSeries,
  type ActorInput,
  type PaceDay,
} from "./ceo-dashboard";

/** A window of `n` days from 2026-09-13, with per-day calls supplied by `calls`. */
function days(n: number, calls: (i: number) => number, leads: (i: number) => number = () => 0): PaceDay[] {
  return Array.from({ length: n }, (_, i) => ({
    day: new Date(Date.UTC(2026, 8, 13 + i)).toISOString().slice(0, 10),
    calls: calls(i),
    leads: leads(i),
    missed: 0,
  }));
}

const actor = (over: Partial<ActorInput> & { id: string }): ActorInput => ({
  name: over.id,
  calls: 0,
  talkSeconds: 0,
  leads: 0,
  won: 0,
  lastCallAt: null,
  ...over,
});

describe("pace", () => {
  it("splits the window in half and reads the fall", () => {
    const p = pace(days(30, (i) => (i < 15 ? 25 : 0)));
    expect(p?.early.perDay).toBe(25);
    expect(p?.late.perDay).toBe(0);
    expect(p?.kind).toBe("fell");
    expect(p?.early.from).toBe("2026-09-13");
    expect(p?.late.to).toBe("2026-10-12");
  });

  it("gives the odd day to the newer half, so the projected pace has the longer base", () => {
    const p = pace(days(7, () => 10));
    // 7 days: 3 early, 4 late.
    expect(p?.early.from).toBe("2026-09-13");
    expect(p?.early.to).toBe("2026-09-15");
    expect(p?.late.from).toBe("2026-09-16");
  });

  it("calls a small drift steady rather than a trend", () => {
    // 20 -> 19 a day is a 5% move: real noise on a telephony floor.
    expect(pace(days(30, (i) => (i < 15 ? 20 : 19)))?.kind).toBe("steady");
    // And an absolute move under a tenth of a call a day is steady whatever
    // the ratio says - 0.4 -> 0.33 is a 17% "drop" of nothing.
    expect(pace(days(30, (i) => (i < 15 ? 0.4 : 0.33)))?.kind).toBe("steady");
  });

  it("reads a rise", () => {
    expect(pace(days(30, (i) => (i < 15 ? 2 : 20)))?.kind).toBe("rose");
  });

  it("refuses a window too short to halve honestly", () => {
    expect(pace(days(3, () => 10))).toBeNull();
  });
});

describe("perDayText", () => {
  it("keeps a decimal where the rate is small and drops a trailing zero", () => {
    expect(perDayText(25.5)).toBe("25.5");
    expect(perDayText(0.5)).toBe("0.5");
    expect(perDayText(0)).toBe("0");
    expect(perDayText(12.0)).toBe("12");
    expect(perDayText(312.4)).toBe("312");
  });
});

describe("forecast", () => {
  it("projects the RECENT pace flat, starting the day after the window", () => {
    const p = pace(days(30, (i) => (i < 15 ? 25 : 4)));
    const f = forecast(p, "2026-10-12", 3);
    expect(f.map((d) => d.day)).toEqual(["2026-10-13", "2026-10-14", "2026-10-15"]);
    // The recent half's 4 a day, not the window's mean of 14.5.
    expect(f.every((d) => d.calls === 4)).toBe(true);
  });

  it("has nothing to project without a pace", () => {
    expect(forecast(null, "2026-10-12")).toEqual([]);
  });
});

describe("paceInsight", () => {
  it("states both halves, the projection and the counterfactual", () => {
    const text = paceInsight(pace(days(30, (i) => (i < 15 ? 25 : 0))), 14);
    expect(text).toContain("fell from 25 a day");
    expect(text).toContain("to 0 a day");
    expect(text).toContain("~0 calls");
    expect(text).toContain("versus ~350 calls at the earlier pace");
  });

  it("says so plainly when nothing moved", () => {
    expect(paceInsight(pace(days(30, () => 10)))).toContain("held at 10 a day");
  });
});

describe("driverSlices", () => {
  const actors = [
    actor({ id: "a", name: "Brindha", calls: 369, leads: 3, wonValue: 750 }),
    actor({ id: "b", name: "Handset", calls: 10, leads: 1, wonValue: 0 }),
  ];

  it("adds the gap between the rows and the real total as Unattributed", () => {
    const { slices } = driverSlices(actors, "revenue", 1500);
    expect(slices.map((s) => [s.name, Math.round(s.fraction * 100)])).toEqual([
      ["Brindha", 50],
      ["Unattributed", 50],
    ]);
  });

  it("divides the authoritative total, never the sum of the rows", () => {
    // 379 attributed calls against a floor total of 389: 10 belong to nobody.
    const { slices } = driverSlices(actors, "calls", 389);
    expect(slices.at(-1)?.name).toBe("Unattributed");
    expect(slices.at(-1)?.value).toBe(10);
    expect(slices.reduce((s, x) => s + x.fraction, 0)).toBeCloseTo(1);
  });

  it("adds no remainder when the rows already account for everything", () => {
    const { slices } = driverSlices(actors, "calls", 379);
    expect(slices.some((s) => s.unattributed)).toBe(false);
  });

  it("never reports a negative remainder when the parts overshoot the whole", () => {
    const { slices } = driverSlices(actors, "calls", 370);
    expect(slices.every((s) => s.fraction >= 0)).toBe(true);
    expect(slices.some((s) => s.unattributed)).toBe(false);
  });

  it("reports revenue as unattributable rather than wholly unattributed on an older API", () => {
    const old = [actor({ id: "a", name: "Brindha", calls: 10 })];
    expect(driverSlices(old, "revenue", 1500).attributable).toBe(false);
    // Counts are unaffected - only revenue is the new field.
    expect(driverSlices(old, "calls", 10).attributable).toBe(true);
  });
});

describe("sliceShare", () => {
  it("never rounds a real slice away to 0%", () => {
    expect(sliceShare(0.004)).toBe("<1%");
    expect(sliceShare(0)).toBe("0%");
    expect(sliceShare(0.95)).toBe("95%");
  });
});

describe("donutArcs", () => {
  it("leaves a gap between arcs and runs them end to end", () => {
    const arcs = donutArcs(
      [
        { id: "a", name: "A", value: 1, fraction: 0.5 },
        { id: "b", name: "B", value: 1, fraction: 0.5 },
      ],
      100,
      2,
    );
    expect(arcs[0]!.dash).toBe("48 52");
    expect(arcs[0]!.offset).toBe(-0);
    expect(arcs[1]!.offset).toBe(-50);
  });

  it("keeps a hairline for a slice smaller than the gap", () => {
    const [tiny] = donutArcs([{ id: "a", name: "A", value: 1, fraction: 0.005 }], 100, 2);
    expect(Number(tiny!.dash.split(" ")[0])).toBeGreaterThan(0);
  });
});

describe("donutWedges", () => {
  /**
   * The hit areas behind the donut's tooltips. Bad arc maths here renders
   * SILENTLY wrong - the wedges are transparent, so a path that is a
   * quarter-turn off or inside-out looks identical and simply shows the wrong
   * slice's tooltip, or none.
   */
  const half = [
    { id: "a", name: "A", value: 1, fraction: 0.5 },
    { id: "b", name: "B", value: 1, fraction: 0.5 },
  ];

  it("gives every slice its own wedge, in order", () => {
    const wedges = donutWedges(half);
    expect(wedges.map((w) => w.id)).toEqual(["a", "b"]);
    for (const w of wedges) expect(w.d).toMatch(/^M [\d.]+ [\d.]+ A /);
  });

  it("starts the first wedge at the ring's own start, so it sits over its arc", () => {
    // The ring draws from 3 o'clock and is rotated -90deg by CSS; the wedges
    // carry the same rotation, so wedge 0 must begin at angle 0 in the same
    // unrotated frame - (50 + outer, 50). A wedge that started elsewhere would
    // name the wrong slice while looking perfectly fine.
    const [first] = donutWedges(half, 33, 50);
    expect(first!.d.startsWith("M 100.000 50.000")).toBe(true);
  });

  it("closes the path back to the inner radius, so the centre is not a hit area", () => {
    // The hole holds the total. A wedge reaching the middle would mean
    // hovering the number shows one arbitrary slice's tooltip.
    const [w] = donutWedges([{ id: "a", name: "A", value: 1, fraction: 0.25 }], 33, 50);
    expect(w!.d).toContain("A 33 33");
    expect(w!.d.endsWith("Z")).toBe(true);
  });

  it("sets the large-arc flag past a half turn, and not before", () => {
    // Without it, a 60% slice draws the 40% wedge instead - the complement -
    // and two slices then claim each other's tooltips.
    const [small] = donutWedges([{ id: "a", name: "A", value: 1, fraction: 0.4 }]);
    const [big] = donutWedges([{ id: "a", name: "A", value: 1, fraction: 0.6 }]);
    expect(small!.d).toMatch(/A 50 50 0 0 1/);
    expect(big!.d).toMatch(/A 50 50 0 1 1/);
  });

  it("does not collapse a single 100% slice into nothing", () => {
    // An arc between two IDENTICAL points draws nothing, so a lone full-circle
    // slice would have no hit area at all - which is precisely the Revenue
    // donut on a tenant whose deals carry no telecaller.
    const [whole] = donutWedges([{ id: "a", name: "A", value: 1, fraction: 1 }]);
    const start = whole!.d.match(/^M ([\d.]+) ([\d.]+)/)!;
    const end = whole!.d.match(/A 50 50 0 1 1 ([\d.]+) ([\d.]+)/)!;
    expect(`${start[1]},${start[2]}`).not.toBe(`${end[1]},${end[2]}`);
  });

  it("runs the wedges end to end, like the arcs they cover", () => {
    const wedges = donutWedges(half, 33, 50);
    // The second wedge starts where the first ends: half a turn round, which
    // in the unrotated frame is 9 o'clock.
    expect(wedges[1]!.d.startsWith("M 0.000 50.000")).toBe(true);
  });
});

describe("effortPlot", () => {
  const actors = [
    actor({ id: "a", name: "Brindha", calls: 369, leads: 3 }),
    actor({ id: "b", name: "Handset", calls: 10, leads: 1 }),
    actor({ id: "c", name: "Silent", calls: 0, leads: 0 }),
  ];

  it("drops anybody with no calls rather than plotting them at zero", () => {
    expect(effortPlot(actors, 389, 5).points.map((p) => p.name)).toEqual(["Brindha", "Handset"]);
  });

  it("puts the busiest caller at the right-hand edge on a decade axis", () => {
    const plot = effortPlot(actors, 389, 5);
    expect(plot.ticks.map((t) => t.value)).toEqual([1, 10, 100, 1000]);
    expect(plot.points[0]!.x).toBeGreaterThan(0.85);
    expect(plot.points[0]!.x).toBeLessThanOrEqual(1);
  });

  it("keeps the team reference line inside the plot", () => {
    const plot = effortPlot(actors, 389, 5);
    expect(plot.teamYield).toBeCloseTo(1.285, 2);
    expect(plot.teamAt).toBeGreaterThan(0);
    expect(plot.teamAt).toBeLessThan(1);
    expect(plot.points.every((p) => p.y >= 0 && p.y <= 1)).toBe(true);
  });

  it("survives a floor that dialled nothing", () => {
    const plot = effortPlot([actor({ id: "a", calls: 0 })], 0, 0);
    expect(plot.points).toEqual([]);
    expect(plot.teamYield).toBeNull();
  });
});

describe("funnelSteps", () => {
  const f = { calls: 389, leads: 5, won: 2, revenue: 1500, collected: null };

  it("formats the per-deal step in the caller's currency", () => {
    const steps = funnelSteps(f, (v) => `INR ${Math.round(v)}`);
    expect(steps[3]!.drop?.text).toBe("INR 750 each");
  });

  it("marks a sub-2% call-to-lead rate as the leak and a strong close as good", () => {
    const steps = funnelSteps(f);
    expect(steps[1]!.drop).toEqual({ text: "1.3% become leads", tone: "bad" });
    expect(steps[2]!.drop).toEqual({ text: "40% won", tone: "good" });
  });

  it("says collections are untracked rather than drawing them as zero", () => {
    const steps = funnelSteps(f);
    expect(steps[4]!.value).toBeNull();
    expect(steps[4]!.at).toBe(0);
    expect(steps[4]!.drop?.text).toBe("collections not tracked");
  });

  it("reads a real collected figure as a rate", () => {
    const steps = funnelSteps({ ...f, collected: 300 });
    expect(steps[4]!.drop).toEqual({ text: "20% recorded as collected", tone: "bad" });
  });

  it("keeps every non-zero bar visible on the log scale and in descending order", () => {
    const steps = funnelSteps(f);
    expect(steps[2]!.at).toBeGreaterThanOrEqual(0.04);
    expect(steps[0]!.at).toBeGreaterThan(steps[1]!.at);
  });

  it("does not divide by zero on an empty window", () => {
    const steps = funnelSteps({ calls: 0, leads: 0, won: 0, revenue: 0, collected: null });
    expect(steps.every((s) => Number.isFinite(s.at))).toBe(true);
    expect(steps[1]!.drop).toBeUndefined();
  });
});

describe("funnelInsight", () => {
  it("names the dials per lead and the close rate", () => {
    expect(funnelInsight({ calls: 389, leads: 5, won: 2, revenue: 1500, collected: null })).toBe(
      "Calls → leads is the leak: 1 lead per 78 dials. Once worked, 40% of leads close.",
    );
  });

  it("says the dials produced nothing rather than dividing by zero", () => {
    expect(funnelInsight({ calls: 50, leads: 0, won: 0, revenue: 0, collected: null })).toContain(
      "produced no leads",
    );
  });
});

describe("scenarios", () => {
  const base = {
    pace: pace(days(30, (i) => (i < 15 ? 25 : 0.5))),
    leadsPerCall: 5 / 389,
    winRate: 0.4,
    dealValue: 750,
    wins: 2,
    leads: 5,
  };

  it("ranks restoring volume below improving quality", () => {
    const { rows } = scenarios(base);
    const [nothing, restore, improve] = rows;
    expect(nothing!.value).toBeLessThan(restore!.value);
    expect(restore!.value).toBeLessThan(improve!.value);
  });

  it("changes exactly one term per row", () => {
    const { rows } = scenarios(base);
    // Restore moves calls/day from 0.5 to 25 - a 50x on the same quality.
    expect(rows[1]!.value / rows[0]!.value).toBeCloseTo(50, 0);
  });

  it("flags low confidence on a handful of deals", () => {
    expect(scenarios(base).lowConfidence).toBe(true);
    expect(scenarios({ ...base, wins: 40, leads: 200 }).lowConfidence).toBe(false);
  });

  it("keeps every bar and its range inside the track", () => {
    const { rows } = scenarios(base);
    for (const r of rows) {
      expect(r.at).toBeGreaterThanOrEqual(0);
      expect(r.highAt).toBeLessThanOrEqual(1);
      expect(r.lowAt).toBeLessThanOrEqual(r.at);
    }
  });

  it("produces zeros rather than NaN with no pace and no wins", () => {
    const { rows } = scenarios({ ...base, pace: null, winRate: null, wins: 0, leads: 0 });
    expect(rows.every((r) => Number.isFinite(r.value))).toBe(true);
  });
});

describe("rankAlerts", () => {
  const base = {
    pace: pace(days(30, (i) => (i < 15 ? 25 : 0.5))),
    revenuePerCall: 1500 / 389,
    neverContacted: 3,
    neverContactedAge: "8–15 days",
    winRate: 0.4,
    dealValue: 750,
    untranscribed: 241,
    totalCalls: 389,
    unmappedHandsets: 3,
    topActor: { name: "Brindha", idleDays: 15, shareOfCalls: 0.95 },
    untrackedRevenue: 1500,
    tracksCollections: false,
    collectionsAvailable: true,
    hrefs: { people: "/p", leads: "/l", finance: "/f", devices: "/d" },
    money: (n: number) => `INR ${Math.round(n)}`,
  };

  it("ranks by money, so a stalled floor outranks a red row worth one deal", () => {
    const keys = rankAlerts(base).map((a) => a.key);
    expect(keys[0]).toBe("pace");
    expect(keys).toContain("never-contacted");
    expect(keys).toContain("collections");
    expect(keys).toContain("transcription");
  });

  it("stays silent where there is nothing to say", () => {
    expect(
      rankAlerts({
        ...base,
        pace: pace(days(30, () => 25)),
        neverContacted: 0,
        untranscribed: 2,
        tracksCollections: true,
        untrackedRevenue: 0,
      }),
    ).toEqual([]);
  });

  it("ignores a fall too small to be worth a row", () => {
    const small = rankAlerts({ ...base, pace: pace(days(30, (i) => (i < 15 ? 1 : 0.6))) });
    expect(small.map((a) => a.key)).not.toContain("pace");
  });

  it("prices the impact column in the workspace's own currency", () => {
    const stalled = rankAlerts(base).find((a) => a.key === "pace");
    expect(stalled?.impact).toMatch(/^−INR \d+ \/ month$/);
    const collections = rankAlerts(base).find((a) => a.key === "collections");
    expect(collections?.impact).toBe("INR 1500 untracked");
  });

  it("says nothing about collections to a workspace without the finance module", () => {
    // The alert's whole action is "create a deal template", on a page
    // `requireFeature` bounces this reader off. Telling them their setup is
    // deficient for want of a module nobody sold them is worse than silence.
    const keys = rankAlerts({ ...base, collectionsAvailable: false }).map((a) => a.key);
    expect(keys).not.toContain("collections");
    // and the rest of the list is untouched
    expect(keys).toContain("pace");
  });

  it("drops the action link where the reader cannot open that page", () => {
    const [top] = rankAlerts({ ...base, hrefs: {} });
    expect(top!.action).toBeNull();
  });

  it("keeps transcription quiet above 80% coverage", () => {
    expect(rankAlerts({ ...base, untranscribed: 50, totalCalls: 389 }).map((a) => a.key)).not.toContain(
      "transcription",
    );
  });
});

describe("activeCallers", () => {
  const roster = [
    actor({ id: "a", name: "Brindha", calls: 369, lastCallAt: "2026-09-27T10:00:00Z" }),
    actor({ id: "b", name: "Handset", calls: 10, lastCallAt: "2026-10-11T10:00:00Z" }),
    actor({ id: "c", name: "Never", calls: 0, lastCallAt: null }),
  ];

  it("counts who DIALLED in the window, not who is online", () => {
    const { active, total } = activeCallers(roster, "2026-10-12", 7);
    expect(active).toBe(1);
    expect(total).toBe(3);
  });

  it("names the busiest caller when they have gone quiet, not the quietest", () => {
    expect(activeCallers(roster, "2026-10-12", 7).idlest).toEqual({ name: "Brindha", idleDays: 15 });
  });

  it("names nobody when the top caller is still dialling", () => {
    const busy = [actor({ id: "a", name: "Brindha", calls: 369, lastCallAt: "2026-10-12T09:00:00Z" })];
    expect(activeCallers(busy, "2026-10-12", 7).idlest).toBeNull();
  });
});

describe("revenuePerCall", () => {
  it("is null rather than zero with nothing dialled", () => {
    expect(revenuePerCall(1500, 0)).toBeNull();
    expect(revenuePerCall(1500, 389)).toBeCloseTo(3.856, 3);
  });
});

describe("parseSeries / parseGrain", () => {
  it("defaults to the two series the page is about", () => {
    expect(parseSeries(undefined)).toEqual(["calls", "leads"]);
    expect(parseSeries("")).toEqual(["calls", "leads"]);
  });

  it("drops unknown keys and never yields an empty chart", () => {
    expect(parseSeries("calls,nonsense")).toEqual(["calls"]);
    expect(parseSeries("nonsense")).toEqual(["calls", "leads"]);
  });

  it("reads every known key", () => {
    expect(parseSeries("calls,leads,yield,missed")).toHaveLength(4);
  });

  it("treats anything but weekly as daily", () => {
    expect(parseGrain("weekly")).toBe("weekly");
    expect(parseGrain("monthly")).toBe("daily");
    expect(parseGrain(undefined)).toBe("daily");
  });
});

describe("bucketByGrain", () => {
  it("passes days through unchanged", () => {
    expect(bucketByGrain(days(3, () => 1), "daily")).toHaveLength(3);
  });

  it("counts whole weeks back from the END, leaving the short bucket on the left", () => {
    const weeks = bucketByGrain(days(10, () => 1), "weekly");
    expect(weeks).toHaveLength(2);
    expect(weeks[0]!.span).toBe(3);
    expect(weeks[1]!.span).toBe(7);
    expect(weeks[1]!.endDay).toBe("2026-09-22");
  });

  it("sums the window exactly, whatever the grain", () => {
    const d = days(30, (i) => i);
    const total = d.reduce((s, x) => s + x.calls, 0);
    expect(bucketByGrain(d, "weekly").reduce((s, b) => s + b.calls, 0)).toBe(total);
  });
});

describe("yieldSeries", () => {
  it("is null until a full span exists", () => {
    const s = yieldSeries(days(10, () => 10, () => 1), 7);
    expect(s.slice(0, 6).every((v) => v === null)).toBe(true);
    expect(s[6]).toBeCloseTo(10);
  });

  it("is null, not zero, where the trailing week had no calls", () => {
    const s = yieldSeries(days(14, (i) => (i < 7 ? 10 : 0), () => 0), 7);
    expect(s[13]).toBeNull();
  });
});
