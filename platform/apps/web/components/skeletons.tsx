import { Card, Skeleton } from "@aura/ui";

/**
 * Same markup as `PageHeader`, for the handful of routes whose title is only
 * known after the fetch (an account/contact's name, a dashboard's org name) -
 * a real `<PageHeader>` can't be used since there's no text to give it yet.
 * Keeping the wash/eyebrow classes identical means the swap-in is a text
 * change, not a layout jump.
 */
export function PageHeaderSkeleton({ context }: { context: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-bg-subtle px-5 py-5 sm:px-7 sm:py-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: "var(--brand-gradient)" }}
      />
      <div className="relative min-w-0">
        <p
          className="bg-clip-text text-xs font-semibold tracking-wider text-transparent uppercase"
          style={{ backgroundImage: "var(--brand-gradient)" }}
        >
          {context}
        </p>
        <Skeleton className="mt-2 h-8 w-48 sm:h-9" />
      </div>
    </div>
  );
}

/**
 * Per-screen loading shapes.
 *
 * Each piece here mirrors one real page shape (see the `page.tsx` it is paired
 * with); route-level `loading.tsx` files compose them. The rule that keeps them
 * honest is GEOMETRY, not decoration: a skeleton earns its place only if the
 * real content lands on top of it without anything moving, so heights, gaps,
 * radii and column tracks are copied from the component being stood in for
 * (`StatCard`, the kit `Table`, `PageHeader`) rather than approximated.
 *
 * Two conventions worth knowing before adding one:
 *
 *  - VARIETY IS DETERMINISTIC. Bar widths come from the fixed cycles below,
 *    never `Math.random()`: this renders on the server and again on the client,
 *    and a random width is a hydration mismatch. The cycles are what stop a
 *    table looking like a stack of identical grey pills.
 *  - CLASS NAMES ARE LITERAL. Tailwind v4 emits CSS only for class names it can
 *    see statically in source, so every width lives in a `const` array of
 *    complete strings and is picked by index. Building `w-${n}` compiles to
 *    nothing and fails silently.
 */

/** Small fixed cycles, picked by index. Literal strings - see above. */
const W_PRIMARY = ["w-36", "w-44", "w-32", "w-40", "w-28", "w-36"] as const;
const W_TEXT = ["w-28", "w-20", "w-32", "w-24", "w-16", "w-28"] as const;
const W_SUB = ["w-24", "w-20", "w-28", "w-16"] as const;
const W_CHIP = ["w-16", "w-20", "w-14", "w-16"] as const;
const W_NUM = ["w-8", "w-10", "w-6", "w-12"] as const;
const W_DATE = ["w-20", "w-24", "w-20", "w-28"] as const;
const W_HEAD = ["w-16", "w-12", "w-20", "w-14", "w-16", "w-10"] as const;
const W_PILL = ["w-16", "w-20", "w-14", "w-24", "w-16", "w-20"] as const;

/** Bar heights as percentages, for chart skeletons. Inline `style`, so not subject to the literal-class rule. */
const BAR_PCT = [42, 68, 55, 84, 60, 38, 92, 58, 76, 48, 66, 80] as const;

function pick<T>(cycle: readonly T[], i: number): T {
  return cycle[i % cycle.length];
}

/** Space-joins the truthy parts. The kit's `cx` is not exported, and this file only needs the join. */
function join(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ══ INLINE REGIONS ═══════════════════════════════════════════════════════════ */

/**
 * The accessible half of a skeleton, for a region that fetches AFTER its page is
 * already on screen - a drawer's timeline, a dialog's checklist, a panel that
 * loads on open.
 *
 * `Skeleton` is `aria-hidden` on purpose, so a region that swaps a bare
 * "Loading…" for skeleton bars would go silent for a screen-reader user. This
 * puts the words back: `role="status"` plus a visually-hidden label, and
 * `aria-busy` so the region is not read half-built.
 *
 * Route-level `loading.tsx` files do NOT need it - Next's own route announcer
 * announces the navigation - and must not use it: they return a bare fragment so
 * the layout's `space-y-*` rhythm still applies to their children.
 */
export function LoadingRegion({
  label = "Loading",
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/**
 * Compact rows for a region inside a drawer, dialog or panel: an optional lead
 * (a timeline dot, a checkbox, an avatar), one or two lines, an optional chip.
 * Tighter than `ListCardSkeleton`, which is a whole card.
 */
export function InlineListSkeleton({
  rows = 3,
  lead = "none",
  trailing = "none",
  twoLine = true,
  label = "Loading",
}: {
  rows?: number;
  lead?: "dot" | "check" | "avatar" | "none";
  trailing?: "chip" | "none";
  twoLine?: boolean;
  label?: string;
}) {
  return (
    <LoadingRegion label={label} className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          {lead === "dot" ? <Skeleton className="size-2.5 shrink-0 rounded-full" /> : null}
          {lead === "check" ? <Skeleton className="size-4 shrink-0" /> : null}
          {lead === "avatar" ? <Skeleton className="size-7 shrink-0 rounded-full" /> : null}
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={join("h-3.5", pick(["w-2/5", "w-1/2", "w-1/3", "w-3/5"], i))} />
            {twoLine ? (
              <Skeleton className={join("h-3", pick(["w-3/4", "w-2/3", "w-4/5", "w-1/2"], i))} />
            ) : null}
          </div>
          {trailing === "chip" ? (
            <Skeleton className={join("h-5 shrink-0 rounded-full", pick(W_CHIP, i))} />
          ) : null}
        </div>
      ))}
    </LoadingRegion>
  );
}

/* ══ HEADINGS, INTRO COPY ═════════════════════════════════════════════════════ */

/**
 * The paragraph under a page header, optionally with the page's one primary
 * action to its right - the operator console's "One instance per customer
 * company... [ + New Instance ]" row.
 */
export function IntroSkeleton({ lines = 2, action = false }: { lines?: number; action?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="w-full max-w-xl space-y-2">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton
            key={i}
            className={join("h-3", i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")}
          />
        ))}
      </div>
      {action ? <Skeleton className="h-10 w-36 shrink-0 rounded-full" /> : null}
    </div>
  );
}

/**
 * A section heading with its one-line subtitle - the `h3` + `text-xs` pair the
 * operator pages use to split a screen into "Across all tenants" / one tenant.
 */
export function SectionHeadingSkeleton({ subtitle = true }: { subtitle?: boolean }) {
  return (
    <div className="space-y-2">
      <Skeleton className="h-6 w-56" />
      {subtitle ? <Skeleton className="h-3 w-72 max-w-full" /> : null}
    </div>
  );
}

/* ══ STAT TILES ═══════════════════════════════════════════════════════════════ */

/** Columns the stat grid may take at `lg`. A lookup, so every class string is a literal. */
const STAT_COLS = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-5",
} as const;

/**
 * A row of N KPI tiles - the dashboard's top row, and every summary strip.
 *
 * Drawn as the real thing: a solid `--color-kpi` tile (the tenant's own brand
 * colour where they have set one - the owner layout re-points the token, and a
 * loading screen renders inside that layout) with `StatCard`'s exact padding
 * and line boxes: a 16px label line, the value in a 36px line, a 16px context
 * line, and the 36px icon tile. That is what stops the band changing height,
 * and changing colour, when the numbers arrive. `tone="plain"` is the
 * unfilled secondary strip (`StatCard tone="plain"`).
 */
export function StatGridSkeleton({
  count = 4,
  columns = 4,
  tone = "kpi",
  icons = true,
}: {
  count?: number;
  columns?: keyof typeof STAT_COLS;
  tone?: "kpi" | "plain";
  icons?: boolean;
}) {
  const filled = tone === "kpi";
  return (
    <div className={join("grid grid-cols-1 gap-4 sm:gap-5", STAT_COLS[columns])}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={join(
            "flex flex-col justify-between rounded-xl border p-6 shadow-card",
            filled ? "border-transparent bg-kpi" : "border-border bg-surface",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex h-4 items-center">
                <Skeleton onFill={filled} className={join("h-3", pick(W_HEAD, i + 1))} />
              </div>
              <div className="mt-2 flex h-10 items-center">
                <Skeleton onFill={filled} className={join("h-7", pick(W_CHIP, i + 2))} />
              </div>
              <div className="mt-1 flex h-4 items-center">
                <Skeleton onFill={filled} className={join("h-2.5", pick(W_TEXT, i))} />
              </div>
            </div>
            {icons ? <Skeleton onFill={filled} className="size-9 shrink-0 rounded-md" /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ══ TABLES ═══════════════════════════════════════════════════════════════════ */

/**
 * What one column of a table holds. This is the difference between "a table"
 * and THIS table: a call log is avatar/chip/duration/date, an invoice list is
 * a number, a customer, an amount and a status, and a run of identical grey
 * bars says none of that.
 *
 *   primary   a bold name                        primary2  a name over a small mono id/sub-line
 *   avatar    a round avatar and a name          text      free text
 *   chip      a status/state chip                num       a short figure or count
 *   date      a date or relative time            actions   a right-hand button or two
 *   check     a selection checkbox               select    an inline dropdown (`size="sm"`)
 *   chipSelect  a status chip stacked over a dropdown - a role shown AND editable
 */
export type CellKind =
  | "primary"
  | "primary2"
  | "avatar"
  | "text"
  | "chip"
  | "num"
  | "date"
  | "actions"
  | "check"
  | "select"
  | "chipSelect";

/** A column is a kind, or a kind with an explicit grid track for the odd wide/narrow one. */
export type Col = CellKind | { kind: CellKind; track?: string };

const TRACK: Record<CellKind, string> = {
  primary: "minmax(0,2.2fr)",
  primary2: "minmax(0,2.2fr)",
  avatar: "minmax(0,2fr)",
  text: "minmax(0,1.6fr)",
  chip: "minmax(0,1fr)",
  num: "minmax(0,0.6fr)",
  date: "minmax(0,1fr)",
  actions: "5rem",
  check: "1.25rem",
  select: "minmax(0,1.2fr)",
  chipSelect: "minmax(0,1.2fr)",
};

function colParts(col: Col): { kind: CellKind; track: string } {
  const kind = typeof col === "string" ? col : col.kind;
  const track = typeof col === "string" ? undefined : col.track;
  return { kind, track: track ?? TRACK[kind] };
}

/**
 * One line of text as the browser lays it out: a bar centred in the line box the
 * real text would occupy. A bare 14px bar makes every row ~6px shorter than the
 * text row it stands in for, and six rows add up to a visible jump when the data
 * arrives. `line` is that box - `h-5` for the kit table's `text-sm` (20px),
 * `h-4` for the ledger's `font-mono text-xs` (16px).
 */
function Line({ line, children }: { line: "h-4" | "h-5"; children: React.ReactNode }) {
  return <div className={join("flex items-center", line)}>{children}</div>;
}

function Cell({ kind, i, line }: { kind: CellKind; i: number; line: "h-4" | "h-5" }) {
  switch (kind) {
    case "primary":
      return (
        <Line line={line}>
          <Skeleton className={join("h-3.5", pick(W_PRIMARY, i))} />
        </Line>
      );
    case "primary2":
      // A 20px name line over a sub-line - both tables set the name at `text-sm`,
      // so the name does not follow `line`. The sub-line does: the ledger's is an
      // inline `text-[10px]` mono span that inherits a 20px line-height and lays
      // out ~22px tall (measured against instances/page.tsx), the kit's is 16px.
      return (
        <div>
          <Line line="h-5">
            <Skeleton className={join("h-3.5", pick(W_PRIMARY, i))} />
          </Line>
          <div className={join("flex items-center", line === "h-4" ? "h-[22px]" : "h-4")}>
            <Skeleton className={join("h-2.5", pick(W_SUB, i))} />
          </div>
        </div>
      );
    case "avatar":
      return (
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <Skeleton className={join("h-3.5", pick(W_TEXT, i))} />
        </div>
      );
    case "text":
      return (
        <Line line={line}>
          <Skeleton className={join("h-3.5", pick(W_TEXT, i))} />
        </Line>
      );
    case "chip":
      return <Skeleton className={join("h-6 rounded-full", pick(W_CHIP, i))} />;
    case "num":
      return (
        <Line line={line}>
          <Skeleton className={join("h-3.5", pick(W_NUM, i))} />
        </Line>
      );
    case "date":
      return (
        <Line line={line}>
          <Skeleton className={join("h-3.5", pick(W_DATE, i))} />
        </Line>
      );
    case "actions":
      return (
        <div className="flex justify-end gap-1.5">
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
        </div>
      );
    case "check":
      return <Skeleton className="size-4" />;
    case "select":
      // `Select size="sm"`: `py-1.5` + a 20px line + the 2px border = 34px.
      return <Skeleton className="h-[34px] w-full max-w-40 rounded-sm" />;
    case "chipSelect":
      return (
        <div className="flex flex-col items-start gap-1.5">
          <Skeleton className={join("h-6 rounded-full", pick(W_CHIP, i))} />
          <Skeleton className="h-[34px] w-full max-w-40 rounded-sm" />
        </div>
      );
  }
}

/**
 * A table: header row, then N body rows of typed cells.
 *
 * Two dialects, because the two consoles draw tables differently and the
 * skeleton has to be the one on the page it sits in:
 *
 *   kit     the owner console's `<Table>` - a `rounded-xl` hairline frame,
 *           one-line rows at `py-3`, a 1px divider.
 *   ledger  the operator console's hand-rolled tables - a `Card` with a 2px
 *           `border-strong` rule under the header, `py-4` rows, and usually a
 *           two-line first cell. Roughly 50% taller per row than `kit`.
 *
 * `columns` is a number for "N generic columns" (what every caller before this
 * passed) or a `Col[]` describing each column.
 *
 * The body is a CSS grid sharing one track template with the header, so columns
 * line up row to row the way real table columns do. It is clipped, not
 * squashed, below `36rem` - the real table scrolls sideways on a phone, and a
 * skeleton that reflowed to fit would look like a different table.
 */
export function TableBlockSkeleton({
  columns = 4,
  rows = 6,
  variant = "kit",
  bare = false,
}: {
  columns?: number | Col[];
  rows?: number;
  variant?: "kit" | "ledger";
  /** No frame of its own: for a table that sits flush inside a card the caller draws. */
  bare?: boolean;
}) {
  const cols: Col[] =
    typeof columns === "number"
      ? Array.from({ length: columns }, (_, i): Col => (i === 0 ? "primary" : "text"))
      : columns;
  const parts = cols.map(colParts);
  const template = parts.map((p) => p.track).join(" ");
  const ledger = variant === "ledger";

  const table = (
    <div className="min-w-[36rem]">
      <div
        className={join(
          "grid items-center gap-4 bg-bg-subtle px-4",
          ledger ? "border-b-2 border-border-strong py-3.5" : "border-b border-border py-3",
        )}
        style={{ gridTemplateColumns: template }}
      >
        {parts.map((p, c) => (
          // The header text's line box, measured against the real tables: ~18px
          // for the kit's `text-xs`, 14px for the ledger's `text-[10px]` mono.
          <div key={c} className={join("flex items-center", ledger ? "h-3.5" : "h-[18px]")}>
            {p.kind === "check" || p.kind === "actions" ? null : (
              <Skeleton className={join("h-2.5", pick(W_HEAD, c))} />
            )}
          </div>
        ))}
      </div>
      <div className={ledger ? "divide-y-2 divide-border" : "divide-y divide-border"}>
        {Array.from({ length: rows }, (_, r) => (
          <div
            key={r}
            className={join("grid items-center gap-4 px-4", ledger ? "py-4" : "py-3")}
            style={{ gridTemplateColumns: template }}
          >
            {parts.map((p, c) => (
              <div key={c} className="min-w-0">
                <Cell kind={p.kind} i={r + c * 2} line={ledger ? "h-4" : "h-5"} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  if (bare) return <div className="overflow-hidden">{table}</div>;

  return ledger ? (
    <Card className="overflow-hidden p-0">{table}</Card>
  ) : (
    <div className="overflow-hidden rounded-xl border border-border">{table}</div>
  );
}

/**
 * A card with a titled strip across the top and a table running flush under it -
 * "Members" with a headcount, "By tenant", "Recent calls". The strip is the
 * operator console's shared panel head: `py-3` around a 20px line, a hairline
 * under it, the subtle wash.
 *
 * `icon` is the small glyph before the title; `meta` is the muted count or
 * caption at the strip's far end.
 */
export function TablePanelSkeleton({
  columns = 4,
  rows = 5,
  variant = "kit",
  icon = true,
  meta = true,
}: {
  columns?: number | Col[];
  rows?: number;
  variant?: "kit" | "ledger";
  icon?: boolean;
  meta?: boolean;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-5 py-3">
        <div className="flex h-5 items-center gap-2">
          {icon ? <Skeleton className="size-4 shrink-0" /> : null}
          <Skeleton className="h-3.5 w-24" />
        </div>
        {meta ? (
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-16" />
          </div>
        ) : null}
      </div>
      <TableBlockSkeleton bare columns={columns} rows={rows} variant={variant} />
    </Card>
  );
}

/* ══ TOOLBARS ═════════════════════════════════════════════════════════════════ */

/**
 * The control row above a list: a search box, filter pills, dropdowns and the
 * page's primary action, in that order, wrapping the way the real row wraps.
 * Sizes are the real controls': a 38px input (`py-2` + a 20px line + border), an
 * `h-8` pill (`calls-explorer`'s filter chip), an `h-9` action.
 */
export function ToolbarSkeleton({
  search = false,
  pills = 0,
  selects = 0,
  action = false,
}: {
  search?: boolean;
  pills?: number;
  selects?: number;
  action?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {search ? <Skeleton className="h-9.5 w-full max-w-sm rounded-sm" /> : null}
      {pills > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: pills }, (_, i) => (
            <Skeleton key={i} className={join("h-8 rounded-full", pick(W_PILL, i))} />
          ))}
        </div>
      ) : null}
      {Array.from({ length: selects }, (_, i) => (
        <Skeleton key={i} className="h-9.5 w-36 rounded-sm" />
      ))}
      {action ? <Skeleton className="ml-auto h-9 w-32 rounded-full" /> : null}
    </div>
  );
}

/** Search-box-then-table pages: accounts, contacts, products. */
export function SearchTableSkeleton({
  columns = 4,
  rows,
  variant,
}: {
  columns?: number | Col[];
  rows?: number;
  variant?: "kit" | "ledger";
}) {
  return (
    <>
      <ToolbarSkeleton search />
      <TableBlockSkeleton columns={columns} rows={rows} variant={variant} />
    </>
  );
}

/** Status-pill-filter-then-table pages: invoices, quotations. */
export function FilterTableSkeleton({
  pills = 5,
  columns = 4,
  rows,
  withAction = false,
  variant,
}: {
  pills?: number;
  columns?: number | Col[];
  rows?: number;
  withAction?: boolean;
  variant?: "kit" | "ledger";
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToolbarSkeleton pills={pills} />
        {withAction ? <Skeleton className="h-9 w-32 rounded-full" /> : null}
      </div>
      <TableBlockSkeleton columns={columns} rows={rows} variant={variant} />
    </>
  );
}

/** Label widths for boxed tabs - "Team", "Roles & permissions", "API keys". */
const W_BOXED = ["w-8", "w-32", "w-14", "w-20", "w-24"] as const;

/**
 * A tab strip. `underline` is the page-level tabs (a hairline under the row,
 * the active one carrying a heavier rule); `pill` is the segmented switcher
 * (inbox filters); `boxed` is a row of small bordered `rounded-md` buttons, the
 * first shaded as the selected one (client-config's section tabs).
 */
export function TabsSkeleton({
  tabs = 4,
  variant = "underline",
}: {
  tabs?: number;
  variant?: "underline" | "pill" | "boxed";
}) {
  if (variant === "boxed") {
    return (
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: tabs }, (_, i) => (
          <div
            key={i}
            className={join(
              "flex h-[34px] items-center rounded-md border px-3",
              i === 0 ? "border-border-strong bg-surface-hover" : "border-border",
            )}
          >
            <Skeleton className={join("h-3.5", pick(W_BOXED, i))} />
          </div>
        ))}
      </div>
    );
  }
  if (variant === "pill") {
    return (
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: tabs }, (_, i) => (
          <Skeleton key={i} className={join("h-8 rounded-full", pick(W_PILL, i))} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex gap-6 overflow-hidden border-b border-border">
      {Array.from({ length: tabs }, (_, i) => (
        <div key={i} className="flex h-10 items-center">
          <Skeleton className={join("h-3.5", pick(W_HEAD, i + 2))} />
        </div>
      ))}
    </div>
  );
}

/** Label widths of the five messaging channels: Overview, Workflows, WhatsApp, WABA, Uploads. */
const CHANNEL_W = ["w-14", "w-16", "w-16", "w-9", "w-12"] as const;

/**
 * The messaging channel strip (`ChannelBar` -> `ChannelSwitcher`) that five
 * pages - Inbox, Outreach, WhatsApp leads, WhatsApp Setup, Bulk Import - each
 * render directly under their own header: a full-bleed hairline carrying `h-11`
 * links, then one line of blurb for the active channel.
 *
 * `active` is the index of the channel THE PAGE ITSELF is (0 Overview/Inbox, 1
 * Workflows/Outreach, 2 WhatsApp, 3 WABA/Setup, 4 Uploads/Import): the loader
 * knows which page it stands in for even though the strip's data is per-reader,
 * and that tab gets the 2px underline the real strip draws under it. The
 * negative margins are the strip's own - they are what lets the rule run to the
 * content edge - so this must be a direct child of `<main>`.
 *
 * Always drawn with all five: the real strip drops whichever a reader's persona
 * or the tenant's features exclude, which a loader cannot know without fetching.
 * A page that leaves this out makes the strip pop in ~70px tall on arrival and
 * push everything under it down.
 */
export function ChannelStripSkeleton({ active = 0 }: { active?: number }) {
  return (
    <div>
      <div className="-mx-4 overflow-hidden border-b border-border px-4 sm:-mx-5 sm:px-5 md:-mx-8 md:px-8">
        <div className="-mb-px flex gap-0.5">
          {CHANNEL_W.map((w, i) => (
            <div
              key={i}
              className={join(
                "flex h-11 shrink-0 items-center border-b-2 px-3 sm:px-4",
                i === active ? "border-border-strong" : "border-transparent",
              )}
            >
              <Skeleton className={join("h-3.5", w)} />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex h-4 items-center">
        <Skeleton className="h-3 w-80 max-w-full" />
      </div>
    </div>
  );
}

/**
 * The operator console's tenant switcher: a label over one pill per tenant.
 *
 * The real `TenantSwitcher` renders nothing for a single tenant, so on an
 * operator with one client this is drawn and then vanishes. That is the wrong
 * way round to be wrong: a platform with one tenant is a dev machine, and the
 * production operator has many.
 */
export function TenantSwitcherSkeleton({ tenants = 3 }: { tenants?: number }) {
  return (
    <div className="space-y-2">
      <div className="flex h-4 items-center">
        <Skeleton className="h-2.5 w-24" />
      </div>
      <ToolbarSkeleton pills={tenants} />
    </div>
  );
}

/* ══ BOARDS, LISTS, GRIDS ═════════════════════════════════════════════════════ */

/** The lead/deal pipeline boards - N columns of stacked drag-cards. */
export function KanbanSkeleton({ columns = 5 }: { columns?: number }) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {Array.from({ length: columns }, (_, col) => (
        <div key={col} className="w-72 shrink-0 space-y-3">
          <div className="flex items-center justify-between px-1">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3.5 w-8" />
          </div>
          <div className="space-y-2.5">
            {Array.from({ length: col === 0 ? 3 : 2 }, (_, card) => (
              <Card key={card} className="space-y-2.5 p-3.5">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** What leads a list row: a square icon tile, a round avatar, or nothing. */
type RowLead = "icon" | "avatar" | "none";
/** What ends a list row: a status chip, an action button, a switch, or nothing. */
type RowTrail = "chip" | "button" | "toggle" | "none";

/**
 * A card of divided rows - the shape behind notifications, the recycle bin, the
 * handset fleet, the SOP list, feature switches, API keys, roles: one thing per
 * row, a lead, one or two lines of text, and a trailing control.
 */
export function ListCardSkeleton({
  rows = 5,
  lead = "none",
  trailing = "none",
  twoLine = true,
  title = false,
}: {
  rows?: number;
  lead?: RowLead;
  trailing?: RowTrail;
  twoLine?: boolean;
  /** A heading strip above the rows. */
  title?: boolean;
}) {
  return (
    <Card className="overflow-hidden p-0">
      {title ? (
        <div className="border-b border-border bg-bg-subtle px-5 py-3.5">
          <Skeleton className="h-3 w-32" />
        </div>
      ) : null}
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3.5 px-5 py-3.5">
            {lead === "icon" ? <Skeleton className="size-9 shrink-0 rounded-md" /> : null}
            {lead === "avatar" ? <Skeleton className="size-9 shrink-0 rounded-full" /> : null}
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className={join("h-3.5", pick(["w-1/3", "w-2/5", "w-1/4", "w-1/2"], i))} />
              {twoLine ? (
                <Skeleton className={join("h-3", pick(["w-2/3", "w-3/5", "w-1/2", "w-3/4"], i))} />
              ) : null}
            </div>
            {trailing === "chip" ? (
              <Skeleton className={join("h-6 shrink-0 rounded-full", pick(W_CHIP, i))} />
            ) : null}
            {trailing === "button" ? <Skeleton className="h-8 w-20 shrink-0 rounded-full" /> : null}
            {trailing === "toggle" ? <Skeleton className="h-6 w-11 shrink-0 rounded-full" /> : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Columns a card grid may take. A lookup, so every class string is a literal. */
const GRID_COLS = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
} as const;

/**
 * A grid of tile cards, each an icon, a title, a couple of lines and an optional
 * footer - agents, integrations, connection providers, module cards.
 */
export function CardGridSkeleton({
  count = 6,
  columns = 3,
  footer = true,
}: {
  count?: number;
  columns?: keyof typeof GRID_COLS;
  footer?: boolean;
}) {
  return (
    <div className={join("grid grid-cols-1 gap-4", GRID_COLS[columns])}>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="size-10 rounded-lg" />
            <Skeleton className={join("h-6 rounded-full", pick(W_CHIP, i))} />
          </div>
          <div className="space-y-2">
            <Skeleton className={join("h-4", pick(["w-2/3", "w-1/2", "w-3/4"], i))} />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
          {footer ? (
            <div className="flex items-center justify-between border-t border-border pt-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-8 w-20 rounded-full" />
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

/* ══ CHARTS ═══════════════════════════════════════════════════════════════════ */

/**
 * A chart card: a title strip and a plot area drawn as the chart it stands in
 * for. `bars` is the volume column chart, `line` a trend with gridlines, `donut`
 * a share ring with its legend, `progress` a stack of labelled meters.
 *
 * Heights are fixed per kind so the card does not resize when the chart mounts.
 */
export function ChartCardSkeleton({
  kind = "bars",
  height = "h-40",
  title = true,
}: {
  kind?: "bars" | "line" | "donut" | "progress";
  /** A literal `h-*` class for the plot area. */
  height?: "h-32" | "h-40" | "h-48" | "h-56";
  title?: boolean;
}) {
  return (
    <Card className="space-y-4">
      {title ? (
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-16" />
        </div>
      ) : null}

      {kind === "bars" ? (
        // Each bar is a wrapper with the percentage height and a skeleton that
        // fills it: `Skeleton` takes no `style`, and a percentage height needs
        // the definite `h-*` on this flex row to resolve against.
        <div className={join("flex items-end gap-1.5", height)}>
          {BAR_PCT.map((pct, i) => (
            <div key={i} className="w-full" style={{ height: `${pct}%` }}>
              <Skeleton className="h-full w-full" />
            </div>
          ))}
        </div>
      ) : null}

      {kind === "line" ? (
        <div className={join("relative", height)}>
          <div className="absolute inset-0 flex flex-col justify-between">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-px w-full bg-border" />
            ))}
          </div>
          <svg
            aria-hidden="true"
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full animate-pulse"
          >
            <polyline
              fill="none"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              className="stroke-border-strong"
              points="0,30 12,24 24,27 36,16 48,20 60,10 72,15 84,7 100,12"
            />
          </svg>
        </div>
      ) : null}

      {kind === "donut" ? (
        <div className="flex items-center gap-6">
          <div className="relative size-32 shrink-0 animate-pulse rounded-full bg-border">
            <div className="absolute inset-6 rounded-full bg-surface" />
          </div>
          <div className="flex-1 space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="size-3 shrink-0 rounded-full" />
                <Skeleton className={join("h-3", pick(W_TEXT, i))} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {kind === "progress" ? (
        <div className="space-y-3.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Skeleton className={join("h-3", pick(W_TEXT, i))} />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * One tile of a report canvas, as the report builder's 12-column grid draws it:
 * a framed card, a title line and a subtitle line, then the chart - or, for a
 * KPI tile, one big figure pinned to the bottom.
 *
 * `className` carries the grid cell only - the literal column span and height
 * (`col-span-3 h-32`) - which names WHERE the tile sits, not how it looks, so it
 * cannot fight the base classes. `flat` is the printed sheet's tile: a hairline
 * frame with no fill and no shadow, drawn in fixed light ink (`onPaper`) because
 * the sheet it sits on is white in both themes.
 */
export function CanvasTileSkeleton({
  className,
  kpi = false,
  flat = false,
}: {
  className: string;
  kpi?: boolean;
  flat?: boolean;
}) {
  return (
    <div
      className={join(
        "flex flex-col overflow-hidden border p-3",
        flat ? "rounded-md border-black/10" : "rounded-lg border-border bg-surface shadow-sm",
        className,
      )}
    >
      <Skeleton onPaper={flat} className="h-3 w-28" />
      <Skeleton onPaper={flat} className="mt-1.5 h-2.5 w-20" />
      {kpi ? (
        <Skeleton onPaper={flat} className="mt-auto h-8 w-20" />
      ) : (
        <Skeleton onPaper={flat} className="mt-3 min-h-0 flex-1" />
      )}
    </div>
  );
}

/* ══ CARDS, DETAIL LAYOUTS, FORMS ═════════════════════════════════════════════ */

/** A `MonoLabel` heading: `text-xs`, so an 18px line, with a bar centred in it. */
function LabelLine({ width = "w-20" }: { width?: string }) {
  return (
    <div className="flex h-[18px] items-center">
      <Skeleton className={join("h-3", width)} />
    </div>
  );
}

/**
 * A `dl`-style details card: a label, then term/value pairs - each an 18px `text-xs`
 * term over an 18px value, ten apart - the way the record pages' Details card sets them.
 */
export function DetailListCardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Card>
      <LabelLine width="w-16" />
      <div className="mt-3 space-y-2.5">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i}>
            <div className="flex h-[18px] items-center">
              <Skeleton className={join("h-2.5", pick(W_HEAD, i + 1))} />
            </div>
            <div className="mt-0.5 flex h-[18px] items-center">
              <Skeleton className={join("h-3", pick(W_TEXT, i))} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * One follow-up as `TaskRow` draws it: an urgency rail down the left edge, a
 * checkbox, the title over a due-date chip (and sometimes a record or assignee),
 * and the Log call / Log message buttons, which fold below the row on a phone.
 * The rail is neutral here - its real colour is a state, and a skeleton has none.
 */
function TaskRowSkeleton({ i }: { i: number }) {
  return (
    <li className="relative px-3 py-3 pl-4">
      <span
        aria-hidden="true"
        className="absolute top-3 bottom-3 left-0 w-1 rounded-full bg-border"
      />
      <div className="flex items-start gap-3">
        <Skeleton className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex h-[21px] items-center">
            <Skeleton className={join("h-3.5", pick(W_PRIMARY, i))} />
          </div>
          <div className="mt-1 flex items-center gap-x-2">
            <Skeleton className="h-[22px] w-20 rounded-full" />
            {i % 2 === 0 ? <Skeleton className="h-3 w-24" /> : null}
          </div>
        </div>
        <div className="hidden shrink-0 gap-1.5 sm:flex">
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-8 w-28 rounded-full" />
        </div>
      </div>
    </li>
  );
}

/**
 * The Follow-ups card on a record page: the label, the add-a-follow-up row (a
 * wide title box, a date box and Add), then a bordered, divided list of tasks.
 */
export function TaskListCardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Card>
      <div className="space-y-3">
        <LabelLine width="w-24" />
        <div className="flex flex-wrap items-end gap-2">
          <Skeleton className="h-9.5 min-w-0 flex-1" />
          <Skeleton className="h-9 w-36 rounded-md" />
          <Skeleton className="h-10 w-14 rounded-full sm:h-8" />
        </div>
        <ul className="divide-y divide-border rounded-md border border-border">
          {Array.from({ length: rows }, (_, i) => (
            <TaskRowSkeleton key={i} i={i} />
          ))}
        </ul>
      </div>
    </Card>
  );
}

/**
 * The Timeline / Activity card on a record page: a label with its ghost "Log
 * activity" button, then a bordered, divided list - a small avatar, then who did
 * it, an icon, what they did and when, wrapping on one line.
 */
export function TimelineCardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <LabelLine width="w-20" />
          <Skeleton className="h-10 w-28 rounded-full sm:h-8" />
        </div>
        <ol className="divide-y divide-border rounded-md border border-border">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="flex items-start gap-3 px-3 py-2.5">
              <Skeleton className="size-7 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="size-3.5" />
                <Skeleton
                  className={join("h-3 max-w-full", pick(["w-56", "w-72", "w-44", "w-64"], i))}
                />
                <Skeleton className="h-3 w-16" />
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

/**
 * A card of a label over a bordered, divided list of two-line links - People on an
 * account, Deals or Conversations on a contact. `sub="chip"` puts a stage chip and
 * a value under each name (a deal); `"text"` puts one muted line (a person's title).
 */
export function BorderedListCardSkeleton({
  rows = 2,
  sub = "text",
}: {
  rows?: number;
  sub?: "text" | "chip";
}) {
  return (
    <Card>
      <LabelLine width="w-16" />
      <ul className="mt-3 divide-y divide-border rounded-md border border-border">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="px-3 py-2">
            <div className="flex h-[18px] items-center">
              <Skeleton className={join("h-3", pick(W_TEXT, i + 2))} />
            </div>
            <div className="mt-0.5 flex h-[18px] items-center gap-2">
              {sub === "chip" ? (
                <>
                  <Skeleton className="h-[22px] w-16 rounded-full" />
                  <Skeleton className="h-2.5 w-12" />
                </>
              ) : (
                <Skeleton className={join("h-2.5", pick(W_SUB, i))} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A generic content card - a label plus a few lines, for timelines/tasklists/composers. */
export function ContentCardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <Card className="space-y-3">
      <Skeleton className="h-3 w-24" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </Card>
  );
}

/**
 * The quotation/invoice detail layout: a back link, a header strip (status +
 * a couple of fields), the line-item table, and a totals/payment block.
 */
export function DocumentDetailSkeleton() {
  return (
    <>
      <Skeleton className="h-3 w-24" />
      <Card className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 w-28" />
        </div>
        <TableBlockSkeleton columns={["primary", "num", "num", "num", "num"]} rows={3} />
        <div className="flex justify-end">
          <div className="w-56 space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      </Card>
    </>
  );
}

/**
 * The fields of a form, unwrapped - a label over a 38px control, N times, then
 * an optional submit button. For a form that sits inside a card the caller has
 * already drawn; `FormCardSkeleton` is this in its own card.
 */
export function FormFieldsSkeleton({
  fields = 3,
  submit = true,
}: {
  fields?: number;
  submit?: boolean;
}) {
  return (
    <>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className={join("h-2.5", pick(W_PRIMARY, i + 3))} />
          <Skeleton className="h-9.5 w-full rounded-sm" />
        </div>
      ))}
      {submit ? <Skeleton className="h-9 w-28 rounded-full" /> : null}
    </>
  );
}

/** A settings/connect form: intro copy already renders from the shell, this is the card(s) below it. */
export function FormCardSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <Card className="max-w-2xl space-y-4">
      <FormFieldsSkeleton fields={fields} />
    </Card>
  );
}

/** A card with a heading strip and a form under it - the operator "create X" panels. */
export function FormPanelSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <Card className="space-y-4">
      <Skeleton className="h-3 w-32" />
      <FormFieldsSkeleton fields={fields} />
    </Card>
  );
}

/**
 * A stat card plus a list card - outreach (stacked, stat card on top) and
 * tasks (side-by-side grid, list on the left) order these differently, so
 * `statFirst` picks the DOM order to match whichever page is rendering.
 */
export function StatPlusListSkeleton({
  side = false,
  statFirst = false,
}: {
  side?: boolean;
  statFirst?: boolean;
}) {
  const stat = (
    <Card key="stat" className="space-y-2">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-8 w-12" />
      <Skeleton className="h-3 w-36" />
    </Card>
  );
  const list = <ContentCardSkeleton key="list" lines={5} />;

  return (
    <div className={side ? "grid gap-6 xl:grid-cols-[1fr_18rem]" : "space-y-4"}>
      {statFirst ? [stat, list] : [list, stat]}
    </div>
  );
}

/** The inbox: a thread list pane beside a conversation pane. */
export function TwoPaneSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      <div className="grid md:grid-cols-[20rem_1fr]">
        <div className="space-y-0 divide-y divide-border border-b border-border md:border-b-0 md:border-r">
          <div className="flex gap-1.5 p-3">
            <Skeleton className="h-7 w-16 rounded-full" />
            <Skeleton className="h-7 w-20 rounded-full" />
            <Skeleton className="h-7 w-16 rounded-full" />
          </div>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-start gap-3 p-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="hidden flex-col gap-3 p-4 md:flex">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-16 w-3/4 rounded-lg" />
          <Skeleton className="ml-auto h-12 w-2/3 rounded-lg" />
          <Skeleton className="h-16 w-3/4 rounded-lg" />
        </div>
      </div>
    </Card>
  );
}

/** The bulk-import wizard's opening step: three pickable entity cards. */
export function EntityPickerSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <Card key={i} className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </Card>
      ))}
    </div>
  );
}

/** The duplicates queue: a scan action row, then a few match cards. */
export function MatchListSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Skeleton className="h-9 w-40 rounded-full" />
        <Skeleton className="h-9 w-40 rounded-full" />
      </div>
      {Array.from({ length: 3 }, (_, i) => (
        <Card key={i} className="space-y-3">
          <Skeleton className="h-3.5 w-1/3" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </Card>
      ))}
    </div>
  );
}
