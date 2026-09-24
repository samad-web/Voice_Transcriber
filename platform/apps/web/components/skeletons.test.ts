import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Skeleton } from "@aura/ui";
import {
  CanvasTileSkeleton,
  BorderedListCardSkeleton,
  ChartCardSkeleton,
  DetailListCardSkeleton,
  InlineListSkeleton,
  ListCardSkeleton,
  LoadingRegion,
  StatGridSkeleton,
  TableBlockSkeleton,
  TaskListCardSkeleton,
  TimelineCardSkeleton,
  TablePanelSkeleton,
  TabsSkeleton,
  TenantSwitcherSkeleton,
  ToolbarSkeleton,
} from "./skeletons";

/**
 * The skeleton vocabulary's contracts.
 *
 * These are the properties the per-screen loaders lean on without ever looking
 * at again, which is why they are pinned here rather than trusted: a regression
 * in any of them changes forty screens at once and passes typecheck, lint and
 * build without a murmur.
 */

const html = (el: ReactElement) => renderToStaticMarkup(el);
const classOf = (markup: string) => /class="([^"]*)"/.exec(markup)?.[1] ?? "";
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("Skeleton radius", () => {
  // The bug this pins: Tailwind emits the radius family ALPHABETICALLY, so a base
  // `rounded-sm` beat `rounded-full`, `-lg` and `-md` and every pill and avatar in
  // every loading screen rendered as a slightly-rounded rectangle.
  it.each(["rounded-full", "rounded-md", "rounded-lg", "rounded-xl", "rounded", "rounded-none"])(
    "drops its base rounded-sm when the caller passes %s",
    (r) => {
      const cls = classOf(html(createElement(Skeleton, { className: `h-6 ${r}` }))).split(/\s+/);
      expect(cls).toContain(r);
      expect(cls).not.toContain("rounded-sm");
    },
  );

  it("keeps the base for a partial-corner or responsive radius, which sit ON TOP of it", () => {
    for (const r of ["rounded-t-lg", "rounded-tl-md", "rounded-s-lg", "md:rounded-full"]) {
      const cls = classOf(html(createElement(Skeleton, { className: `h-6 ${r}` }))).split(/\s+/);
      expect(cls, r).toContain("rounded-sm");
    }
  });

  it("keeps the base when the caller sets no radius", () => {
    expect(classOf(html(createElement(Skeleton, { className: "h-4 w-full" })))).toContain(
      "rounded-sm",
    );
  });
});

describe("Skeleton fill", () => {
  it("is bg-border by default and never carries two backgrounds", () => {
    const cls = classOf(html(createElement(Skeleton, {})));
    expect(cls).toContain("bg-border");
    expect(cls).not.toContain("bg-kpi-fg");
  });

  it("swaps - rather than stacks - its fill for onFill", () => {
    const cls = classOf(html(createElement(Skeleton, { onFill: true })));
    expect(cls).toContain("bg-kpi-fg/25");
    expect(cls).not.toContain("bg-border");
  });

  it("is hidden from assistive tech", () => {
    expect(html(createElement(Skeleton, {}))).toContain('aria-hidden="true"');
  });
});

describe("StatGridSkeleton", () => {
  it("draws one tile per count", () => {
    expect(
      count(html(createElement(StatGridSkeleton, { count: 5, columns: 5 })), "rounded-xl border"),
    ).toBe(5);
  });

  it("is the solid KPI fill, with bars drawn on it, by default", () => {
    const out = html(createElement(StatGridSkeleton, { count: 2 }));
    expect(out).toContain("bg-kpi");
    expect(out).toContain("bg-kpi-fg/25");
    expect(out).not.toContain("bg-border");
  });

  it("is a plain card, with plain bars, for the unfilled secondary strip", () => {
    const out = html(createElement(StatGridSkeleton, { count: 2, tone: "plain" }));
    expect(out).toContain("bg-surface");
    expect(out).not.toContain("bg-kpi");
  });
});

describe("TableBlockSkeleton", () => {
  it("keeps header and body on ONE grid template so columns line up", () => {
    const out = html(
      createElement(TableBlockSkeleton, { columns: ["avatar", "chip", "num", "date"], rows: 3 }),
    );
    const templates = [...out.matchAll(/grid-template-columns:([^;"]*)/g)].map((m) => m[1]);
    // one header + three rows
    expect(templates).toHaveLength(4);
    expect(new Set(templates).size).toBe(1);
  });

  it("draws the cell the column names", () => {
    const chips = html(createElement(TableBlockSkeleton, { columns: ["chip"], rows: 4 }));
    // status chips are pills; a plain text column has none
    expect(count(chips, "rounded-full")).toBe(4);
    const text = html(createElement(TableBlockSkeleton, { columns: ["text"], rows: 4 }));
    expect(count(text, "rounded-full")).toBe(0);
  });

  it("gives selectable and action columns no header label", () => {
    const withLabels = html(
      createElement(TableBlockSkeleton, { columns: ["text", "text"], rows: 1 }),
    );
    const without = html(
      createElement(TableBlockSkeleton, { columns: ["check", "actions"], rows: 1 }),
    );
    // header bars are h-2.5; body cells never use that height on these kinds
    expect(count(withLabels, "h-2.5")).toBe(2);
    expect(count(without, "h-2.5")).toBe(0);
  });

  it("still accepts a bare column count, as every caller before the typed form did", () => {
    const out = html(createElement(TableBlockSkeleton, { columns: 5, rows: 2 }));
    const tracks = /grid-template-columns:([^;"]*)/.exec(out)?.[1].trim().split(" ") ?? [];
    expect(tracks).toHaveLength(5);
  });

  it("draws the two dialects differently: 1px kit rules vs the operator console's 2px ledger", () => {
    const kit = html(createElement(TableBlockSkeleton, { columns: 3, rows: 2 }));
    const ledger = html(
      createElement(TableBlockSkeleton, { columns: 3, rows: 2, variant: "ledger" }),
    );
    expect(kit).toContain("divide-y divide-border");
    expect(kit).not.toContain("divide-y-2");
    expect(ledger).toContain("divide-y-2");
    expect(ledger).toContain("border-border-strong");
  });

  it("clips rather than squashes on a narrow screen, like the scrolling table it stands in for", () => {
    const out = html(createElement(TableBlockSkeleton, { columns: 6 }));
    expect(out).toContain("min-w-[36rem]");
    expect(out).toContain("overflow-hidden");
  });
});

describe("determinism", () => {
  // Skeletons render on the server and again on the client; a random width is a
  // hydration mismatch. Rendering twice must give byte-identical markup.
  it.each([
    [
      "table",
      () => createElement(TableBlockSkeleton, { columns: ["avatar", "chip", "num"], rows: 6 }),
    ],
    ["stats", () => createElement(StatGridSkeleton, { count: 4 })],
    ["list", () => createElement(ListCardSkeleton, { rows: 5, lead: "avatar", trailing: "chip" })],
    ["chart", () => createElement(ChartCardSkeleton, { kind: "bars" })],
    [
      "toolbar",
      () => createElement(ToolbarSkeleton, { search: true, pills: 6, selects: 2, action: true }),
    ],
  ])("%s renders identically twice", (_name, make) => {
    expect(html(make())).toBe(html(make()));
  });
});

describe("ChartCardSkeleton", () => {
  it("gives every bar a real height (Skeleton takes no style, so the wrapper carries it)", () => {
    const out = html(createElement(ChartCardSkeleton, { kind: "bars" }));
    const heights = [...out.matchAll(/style="height:(\d+)%"/g)].map((m) => Number(m[1]));
    expect(heights.length).toBeGreaterThanOrEqual(8);
    expect(heights.every((h) => h > 0 && h <= 100)).toBe(true);
    // and they are not all the same - a flat row of bars reads as a divider
    expect(new Set(heights).size).toBeGreaterThan(3);
  });
});

describe("inline regions keep their accessible announcement", () => {
  // The bare "Loading…" text these replace was the ONLY thing a screen-reader
  // user got for a region that fetches after the page is up.
  it("LoadingRegion is a busy live region with a visually-hidden label", () => {
    const out = html(createElement(LoadingRegion, { label: "Loading activity", children: "x" }));
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('<span class="sr-only">Loading activity</span>');
  });

  it("InlineListSkeleton carries the label through", () => {
    const out = html(createElement(InlineListSkeleton, { rows: 2, label: "Loading tasks" }));
    expect(out).toContain("Loading tasks");
    expect(out).toContain('role="status"');
  });
});

describe("CanvasTileSkeleton", () => {
  it("is a shadowed, filled card by default and a bare hairline frame when flat", () => {
    const framed = classOf(html(createElement(CanvasTileSkeleton, { className: "col-span-3" })));
    const flat = classOf(
      html(createElement(CanvasTileSkeleton, { className: "col-span-3", flat: true })),
    );
    expect(framed).toContain("shadow-sm");
    expect(framed).toContain("bg-surface");
    expect(flat).not.toContain("shadow-sm");
    expect(flat).not.toContain("bg-surface");
    // the grid cell rides through untouched
    expect(framed).toContain("col-span-3");
  });

  it("pins a KPI tile's figure to the bottom and lets a chart tile's plot fill the rest", () => {
    expect(html(createElement(CanvasTileSkeleton, { className: "x", kpi: true }))).toContain(
      "mt-auto",
    );
    expect(html(createElement(CanvasTileSkeleton, { className: "x" }))).toContain("flex-1");
  });
});

describe("TenantSwitcherSkeleton", () => {
  it("is a label over one pill per tenant", () => {
    const out = html(createElement(TenantSwitcherSkeleton, { tenants: 4 }));
    expect(count(out, "h-8 ")).toBe(4);
    expect(count(out, "rounded-full")).toBe(4);
  });
});

describe("TabsSkeleton boxed", () => {
  it("is bordered rounded-md buttons with the first one shaded as selected", () => {
    const out = html(createElement(TabsSkeleton, { variant: "boxed", tabs: 3 }));
    const boxes = [...out.matchAll(/class="(flex h-\[34px\][^"]*)"/g)].map((m) => m[1]);
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => b.includes("rounded-md") && b.includes("border"))).toBe(true);
    expect(boxes[0]).toContain("bg-surface-hover");
    expect(boxes[1]).not.toContain("bg-surface-hover");
  });
});

describe("select cells and the panel table", () => {
  it("draws a dropdown at the real Select size='sm' height", () => {
    const out = html(
      createElement(TableBlockSkeleton, { columns: ["select", "chipSelect"], rows: 2 }),
    );
    // one select per row, plus the select half of each chipSelect
    expect(count(out, "h-[34px]")).toBe(4);
  });

  it("a bare table has no frame of its own, so a panel does not double-frame it", () => {
    const framed = html(createElement(TableBlockSkeleton, { columns: 3, rows: 2 }));
    const bare = html(createElement(TableBlockSkeleton, { columns: 3, rows: 2, bare: true }));
    expect(framed).toContain("rounded-xl border");
    expect(bare).not.toContain("rounded-xl");
    const panel = html(createElement(TablePanelSkeleton, { columns: 3, rows: 2 }));
    // exactly one rounded frame - the card's - with the table flush inside it
    expect(count(panel, "rounded-xl")).toBe(1);
    expect(panel).toContain("bg-bg-subtle");
  });
});

describe("Skeleton onPaper", () => {
  // The printed report sits on a fixed bg-white sheet in BOTH themes. bg-border is
  // dark grey in dark mode - heavy black ink on white paper - so paper gets a fixed
  // 10% black instead.
  it("swaps the base fill for a fixed light ink", () => {
    const cls = classOf(html(createElement(Skeleton, { onPaper: true })));
    expect(cls).toContain("bg-black/10");
    expect(cls).not.toContain("bg-border");
    expect(cls).not.toContain("bg-kpi-fg");
  });

  it("lets onFill win if both are (mistakenly) set - never two backgrounds", () => {
    const cls = classOf(html(createElement(Skeleton, { onFill: true, onPaper: true })));
    expect(cls).toContain("bg-kpi-fg/25");
    expect(cls).not.toContain("bg-black/10");
  });

  it("draws a flat canvas tile entirely in paper ink, and a framed one in theme tokens", () => {
    const flat = html(createElement(CanvasTileSkeleton, { className: "x", flat: true }));
    const framed = html(createElement(CanvasTileSkeleton, { className: "x" }));
    expect(flat).toContain("border-black/10");
    expect(flat).not.toContain("bg-border");
    expect(count(flat, "bg-black/10")).toBe(3); // title, subtitle, plot
    expect(framed).toContain("border-border");
    expect(framed).not.toContain("bg-black/10");
  });
});

describe("record-page cards", () => {
  it("TaskListCardSkeleton draws one urgency-railed row per task, in a bordered divided list", () => {
    const out = html(createElement(TaskListCardSkeleton, { rows: 4 }));
    expect(count(out, "w-1 rounded-full bg-border")).toBe(4); // the rails
    expect(out).toContain("divide-y divide-border rounded-md border border-border");
    // the add row: a title box, a date box and Add - before the list, not inside it
    expect(out.indexOf("h-9.5")).toBeLessThan(out.indexOf("<ul"));
  });

  it("TimelineCardSkeleton draws an avatar per row and the ghost Log activity button", () => {
    const out = html(createElement(TimelineCardSkeleton, { rows: 3 }));
    expect(count(out, "size-7 shrink-0 rounded-full")).toBe(3);
    expect(out).toContain("sm:h-8"); // the kit's size="sm" button
  });

  it("BorderedListCardSkeleton puts a stage chip under a deal and one muted line under a person", () => {
    const chip = html(createElement(BorderedListCardSkeleton, { rows: 2, sub: "chip" }));
    const text = html(createElement(BorderedListCardSkeleton, { rows: 2, sub: "text" }));
    expect(count(chip, "h-[22px] w-16 rounded-full")).toBe(2);
    expect(count(text, "rounded-full")).toBe(0);
  });

  it("DetailListCardSkeleton sets each term and value in a real 18px line box", () => {
    const out = html(createElement(DetailListCardSkeleton, { rows: 3 }));
    // one label line + a term line and a value line per row
    expect(count(out, "h-[18px]")).toBe(1 + 3 * 2);
  });
});
