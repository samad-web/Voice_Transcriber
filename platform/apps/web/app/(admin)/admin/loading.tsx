import type { ReactNode } from "react";
import { Card, MonoLabel, Skeleton } from "@aura/ui";

/** One column of a panel table: its grid track, whether it right-aligns, and what a cell holds. */
interface PanelCol {
  track: string;
  end?: boolean;
  /** A column with no header label (the row-action column). */
  blankHead?: boolean;
  cell: (row: number) => ReactNode;
}

/** Fixed width cycles, picked by index - never random, so server and client agree. Literal classes. */
const HEAD_W = ["w-14", "w-16", "w-12", "w-14", "w-12"] as const;
const NAME_W = ["w-36", "w-44", "w-32", "w-40", "w-28"] as const;
const NUM_W = ["w-10", "w-8", "w-12", "w-6", "w-10"] as const;
const STAGE_W = ["w-20", "w-24", "w-28", "w-24"] as const;

/** Provisioning: tenant, its module chips, the WhatsApp provider chip, a Configure button. */
const PROVISIONING_COLS: PanelCol[] = [
  {
    track: "minmax(0,1.6fr)",
    cell: (r) => <Skeleton className={`h-3.5 ${NAME_W[r % NAME_W.length]}`} />,
  },
  {
    track: "minmax(0,2.6fr)",
    cell: (r) => (
      <div className="flex flex-wrap gap-1">
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
        {r % 2 === 0 ? <Skeleton className="h-6 w-14 rounded-full" /> : null}
      </div>
    ),
  },
  { track: "minmax(0,1fr)", cell: () => <Skeleton className="h-6 w-20 rounded-full" /> },
  {
    track: "6rem",
    end: true,
    blankHead: true,
    cell: () => <Skeleton className="h-10 w-20 rounded-full sm:h-8" />,
  },
];

/** Tenants: name over a mono id, region, call and device counts, a right-aligned status chip. */
const TENANT_COLS: PanelCol[] = [
  {
    track: "minmax(0,2.2fr)",
    cell: (r) => (
      <div className="space-y-1.5">
        <Skeleton className={`h-3.5 ${NAME_W[r % NAME_W.length]}`} />
        <Skeleton className="h-2.5 w-40" />
      </div>
    ),
  },
  { track: "minmax(0,1fr)", cell: () => <Skeleton className="h-3 w-20" /> },
  {
    track: "minmax(0,0.8fr)",
    cell: (r) => <Skeleton className={`h-3 ${NUM_W[r % NUM_W.length]}`} />,
  },
  {
    track: "minmax(0,0.8fr)",
    cell: (r) => <Skeleton className={`h-3 ${NUM_W[(r + 2) % NUM_W.length]}`} />,
  },
  {
    track: "minmax(0,1fr)",
    end: true,
    cell: () => <Skeleton className="h-6 w-16 rounded-full" />,
  },
];

/**
 * A panel's table on one shared grid: a subtle header row, then divided body
 * rows. The panel's own strip is drawn by the caller, so this sits flush under
 * it. Clipped, not squashed, below 36rem - the real table scrolls sideways.
 */
function PanelTable({ cols, rows }: { cols: PanelCol[]; rows: number }) {
  const template = cols.map((c) => c.track).join(" ");
  return (
    <div className="min-w-[36rem]">
      <div
        className="grid items-center gap-4 border-b border-border bg-bg-subtle px-5 py-2.5"
        style={{ gridTemplateColumns: template }}
      >
        {cols.map((c, ci) => (
          <div
            key={ci}
            className={c.end ? "flex h-4 items-center justify-end" : "flex h-4 items-center"}
          >
            {c.blankHead ? null : <Skeleton className={`h-2.5 ${HEAD_W[ci % HEAD_W.length]}`} />}
          </div>
        ))}
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, r) => (
          <div
            key={r}
            className="grid items-center gap-4 px-5 py-3"
            style={{ gridTemplateColumns: template }}
          >
            {cols.map((c, ci) => (
              <div key={ci} className={c.end ? "flex min-w-0 justify-end" : "min-w-0"}>
                {c.cell(r)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Mirrors (admin)/admin/page.tsx. Unlike every other console page this one draws
 * its own full-page <main> shell - the (admin) layout adds no chrome - so the
 * loader has to as well, or the skeleton would sit flush against the viewport and
 * jump when the page arrives. The heading is static, so it is real; below it, the
 * provisioning panel (strip with its action, tenant / modules / WhatsApp / configure
 * table), the tenants panel (tenant / region / calls / devices / status), and the
 * global pipeline health card (four stage tiles, then a queue summary line).
 */
export default function AdminLoading() {
  return (
    <main className="min-h-dvh space-y-6 p-4 sm:p-6 md:p-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-text text-lg font-semibold text-bg select-none">
          A
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl leading-none font-extrabold tracking-tight text-text sm:text-3xl md:text-4xl">
            Platform Admin
          </h1>
          <MonoLabel className="mt-1">Restricted &middot; platform_admin</MonoLabel>
        </div>
      </div>

      <Card elevated className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-subtle px-5 py-3.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-44" />
          <Skeleton className="ml-auto h-10 w-40 rounded-full sm:h-8" />
        </div>
        <PanelTable cols={PROVISIONING_COLS} rows={4} />
      </Card>

      <Card elevated className="overflow-hidden p-0">
        <div className="border-b border-border bg-bg-subtle px-5 py-3.5">
          <div className="flex h-5 items-center gap-2">
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className="h-3.5 w-20" />
          </div>
        </div>
        <PanelTable cols={TENANT_COLS} rows={5} />
      </Card>

      <Card elevated className="space-y-4">
        <div className="flex h-5 items-center gap-2">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-3.5 w-44" />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STAGE_W.map((w, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className={`h-3 ${w}`} />
                <Skeleton className="h-6 w-14 rounded-full" />
              </div>
              <div className="flex gap-4">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <Skeleton className="h-6 w-32 rounded-full" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-28" />
        </div>
      </Card>
    </main>
  );
}
