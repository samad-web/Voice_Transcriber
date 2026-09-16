import type { Metadata } from "next";
import Link from "next/link";
import { LayoutGrid, Rows3 } from "lucide-react";
import { Card, EmptyState, MonoLabel } from "@aura/ui";
import { OWNER_ROLE_ADMINS } from "@aura/shared";
import { PageHeader } from "@/components/page-header";
import { Pager } from "@/components/pager";
import { normaliseStaleAfterDays } from "@/lib/deal-staleness";
import { viewQueryFrom } from "@/lib/list-views";
import { formatDateRange } from "@/lib/report-dashboard";
import { getOwner, ownerGet } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import type { Deal, DealBoardColumn, Stage } from "../types";
import { FilterLink } from "../filter-link";
import { FilterSearch, FilterSelect, ListFilterForm } from "../list-filters";
import { loadMembers, loadTags } from "../list-data";
import { ownerOptions, tagOptions, withCurrent } from "../list-options";
import { SavedViewsBar } from "../saved-views/saved-views-bar";
import { loadSavedViews } from "../saved-views/load";
import { DealsBoard } from "./deals-board";
import { DealsTable } from "./deals-table";
import { dealsHref, parseDealsState, type DealsState } from "./deals-url";
import { StagePackPicker } from "./stage-pack-picker";
import { StaleThreshold } from "./stale-threshold";

export const metadata: Metadata = { title: "Deals" };

/** Rows per table page. Paged on the server - the table never holds the whole pipeline. */
const TABLE_PAGE_SIZE = 50;

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "closed", label: "Closed (won or lost)" },
];

interface DealBoardResponse {
  pipelineId: string;
  columns: DealBoardColumn[];
  stages: Stage[];
  orphaned: number;
  /** Absent from an API deployed ahead of migration 0106. */
  staleAfterDays?: number;
}

interface PipelineSummary {
  id: string;
  name: string;
  is_default: boolean;
  status: "active" | "archived";
  stages: Stage[];
  /** Migration 0106; absent from an older API. */
  stale_after_days?: number;
}

/**
 * CRM Phase 1 foundation (E0.1) - the Deal board, alongside /owner/board
 * (leads) rather than replacing it.
 *
 * ── A BOARD IS A PIPELINE, AND THE URL SAYS WHICH ───────────────────────────
 *
 * An org can have several pipelines, and this page used to show only the
 * default one: no picker, and `?pipelineId=` ignored, so every deal on any other
 * pipeline was unreachable from the console - not from the nav and not by URL
 * (doc 23, G1). The selection now lives in `?pipelineId=`, exactly as the Lead
 * Board keeps its project filter in `?projectId=`, so a refresh, the back button
 * and a shared link all land on the same board.
 *
 * With no id the page shows the org's default, and the picker row is hidden
 * while the org has only one pipeline - so for most tenants nothing changes.
 *
 * ── EMPTY STATES THAT SAY WHAT IS ACTUALLY WRONG ────────────────────────────
 *
 * Three different situations used to render the same "the platform API did not
 * answer" card, because a missing pipeline made the board endpoint 404 and
 * ownerGet turns every failure into null (doc 23, G3). They are now told apart
 * from the pipeline list, which is fetched first:
 *   - the list itself did not load   -> the API really did not answer;
 *   - the org has no active pipeline -> say so;
 *   - `?pipelineId=` names nothing     -> say so, and offer the real ones.
 *
 * ── BOARD OR TABLE, SAME DEALS ──────────────────────────────────────────────
 *
 * `?view=table` shows the same pipeline as paged rows (deals-table.tsx) with a
 * stage filter, a stale filter and sortable columns. Every link on the page is
 * built by deals-url.ts from the WHOLE current state, so switching pipeline
 * keeps the view and its filters instead of dropping back to the board.
 *
 * Both views flag deals idle past the pipeline's own threshold (migration
 * 0106, lib/deal-staleness.ts), which an owner or manager changes inline.
 */
export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("deals");

  const sp = await searchParams;
  const state = parseDealsState(sp);
  const requestedId = state.pipelineId;
  // What a saved view of this screen would keep - see lib/list-views.ts.
  const viewQuery = viewQueryFrom("deals", sp);

  const [list, owner, views] = await Promise.all([
    ownerGet<{ pipelines: PipelineSummary[] }>("/v1/pipelines"),
    getOwner(),
    loadSavedViews("deals"),
  ]);
  if (!list) return <Unavailable />;
  const savedViews = <SavedViewsBar list="deals" views={views} current={viewQuery} allLabel="All deals" />;

  const pipelines = list.pipelines;
  const active = pipelines.filter((p) => p.status === "active");
  const requested = requestedId ? pipelines.find((p) => p.id === requestedId) : undefined;

  if (active.length === 0 && !requested) {
    return (
      <>
        <PageHeader title="Deals" context="Pipeline" />
        <Card>
          <EmptyState
            title="No pipeline set up yet"
            description="Deals live on a pipeline - the columns a deal moves through. This workspace has none that is active, so there is nowhere to show deals yet. Ask your account manager to set one up."
          />
        </Card>
      </>
    );
  }

  const selected = requested ?? active.find((p) => p.is_default) ?? active[0];
  // The row lists every active pipeline, plus an archived one when that is
  // what the URL asked for - otherwise the current board would have no chip.
  const options = selected.status === "archived" ? [...active, selected] : active;
  const picker =
    options.length > 1 ? (
      <div>
        <MonoLabel>Pipeline</MonoLabel>
        <nav aria-label="Choose a pipeline" className="mt-1.5 flex flex-wrap gap-1.5">
          {options.map((p) => (
            <FilterLink
              key={p.id}
              active={p.id === selected.id}
              // The stage filter belongs to the old pipeline's columns, so it
              // does not travel; the view and the stale filter do.
              href={dealsHref(state, { pipelineId: p.id, stage: null })}
            >
              {p.name}
              {p.status === "archived" ? " (archived)" : ""}
            </FilterLink>
          ))}
        </nav>
      </div>
    ) : null;

  if (requestedId && !requested) {
    return (
      <>
        <PageHeader title="Deals" context="Pipeline" />
        <Card>
          <EmptyState
            title="That pipeline doesn't exist"
            description="The link points at a pipeline that is not in this workspace. Pick one of yours below."
          />
        </Card>
        {picker ?? (
          <div>
            <MonoLabel>Pipeline</MonoLabel>
            <nav aria-label="Choose a pipeline" className="mt-1.5 flex flex-wrap gap-1.5">
              {active.map((p) => (
                <FilterLink
                  key={p.id}
                  active={false}
                  href={dealsHref(state, { pipelineId: p.id, stage: null })}
                >
                  {p.name}
                </FilterLink>
              ))}
            </nav>
          </div>
        )}
      </>
    );
  }

  // Every link below is built from this state, never by hand - see deals-url.ts.
  const current: DealsState = { ...state, pipelineId: selected.id === requestedId ? requestedId : null };
  const staleAfterDays = normaliseStaleAfterDays(selected.stale_after_days);
  const canEditThreshold = owner ? OWNER_ROLE_ADMINS.includes(owner.membership.ownerRole) : false;

  const toolbar = (
    <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ViewToggle state={current} />
        <StaleThreshold pipelineId={selected.id} days={staleAfterDays} canEdit={canEditThreshold} />
      </div>
      {/* Beside the board rather than buried in a settings page: the moment
          somebody notices their columns are wrong is the moment they are
          looking at them. It edits the pipeline on screen, not always the
          default. */}
      <StagePackPicker pipelineId={selected.id} />
    </div>
  );
  const archivedNote =
    selected.status === "archived" ? (
      <p className="text-sm text-text-muted">
        This pipeline is archived. Its deals are shown for reference; new deals go to an active
        pipeline.
      </p>
    ) : null;

  if (state.view === "table") {
    const query = new URLSearchParams({
      pipelineId: selected.id,
      sort: state.sort,
      limit: String(TABLE_PAGE_SIZE),
      offset: String((state.page - 1) * TABLE_PAGE_SIZE),
    });
    if (state.stage) query.set("stage", state.stage);
    if (state.staleOnly) query.set("staleDays", String(staleAfterDays));
    if (state.owner) query.set("owner", state.owner);
    if (state.tagId) query.set("tagId", state.tagId);
    if (state.q) query.set("q", state.q);
    if (state.status) query.set("status", state.status);
    if (state.createdFrom) query.set("createdFrom", state.createdFrom);
    if (state.createdTo) query.set("createdTo", state.createdTo);
    const [rows, members, tags] = await Promise.all([
      ownerGet<{ deals: Deal[]; total: number }>(`/v1/deals?${query}`),
      loadMembers(),
      loadTags(),
    ]);
    if (!rows) return <Unavailable />;

    const stages: Stage[] = Array.isArray(selected.stages) ? selected.stages : [];
    return (
      <>
        <PageHeader title="Deals" context="Pipeline" />
        {savedViews}
        {toolbar}
        {picker}
        {archivedNote}
        {/* Search, owner and tag as a form; stage and stale stay the chip row
            below. `keep` carries the chips' state through a form change and the
            form's fields through a chip click (dealsHref), so neither drops
            the other. */}
        <ListFilterForm
          key={dealsHref(current)}
          path="/owner/deals"
          label="Filter deals"
          keep={{
            pipelineId: current.pipelineId,
            view: "table",
            stage: current.stage,
            stale: current.staleOnly ? "1" : null,
            createdFrom: current.createdFrom,
            createdTo: current.createdTo,
            sort: current.sort === "activity" ? null : current.sort,
          }}
        >
          <FilterSearch defaultValue={current.q ?? undefined} placeholder="Deal name or summary" label="Search deals" />
          <FilterSelect name="status" label="Status" defaultValue={current.status} options={STATUS_OPTIONS} />
          <FilterSelect
            name="owner"
            label="Owner"
            defaultValue={current.owner}
            options={withCurrent(ownerOptions(members), current.owner ?? undefined)}
          />
          {tags.length > 0 || current.tagId ? (
            <FilterSelect
              name="tagId"
              label="Tag"
              defaultValue={current.tagId}
              options={withCurrent(tagOptions(tags), current.tagId ?? undefined)}
            />
          ) : null}
        </ListFilterForm>
        <nav aria-label="Filter deals" className="flex flex-wrap items-center gap-1.5">
          <FilterLink active={!state.stage} href={dealsHref(current, { stage: null })}>
            All stages
          </FilterLink>
          {stages.map((s) => (
            <FilterLink key={s.key} active={state.stage === s.key} href={dealsHref(current, { stage: s.key })}>
              {s.label}
            </FilterLink>
          ))}
          <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
          <FilterLink active={state.staleOnly} href={dealsHref(current, { staleOnly: !state.staleOnly })}>
            Idle {staleAfterDays}+ days
          </FilterLink>
          {/* Set by a Reports drill-down, not by a control here: shown so the
              list never silently holds a window nobody can see, and clearable. */}
          {state.createdFrom || state.createdTo ? (
            <>
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
              <FilterLink active href={dealsHref(current, { createdFrom: null, createdTo: null })}>
                Created {formatDateRange(state.createdFrom ?? state.createdTo!, state.createdTo ?? state.createdFrom!)}
                <span aria-hidden="true" className="ml-1.5">✕</span>
                <span className="sr-only"> - remove this filter</span>
              </FilterLink>
            </>
          ) : null}
        </nav>
        <DealsTable deals={rows.deals} stages={stages} staleAfterDays={staleAfterDays} state={current} />
        <Pager
          total={rows.total}
          page={state.page}
          pageSize={TABLE_PAGE_SIZE}
          noun="deal"
          previousLabel="← Previous"
          nextLabel="Next →"
          hrefFor={(page) => dealsHref(current, { page })}
        />
      </>
    );
  }

  const data = await ownerGet<DealBoardResponse>(
    `/v1/deals/board?perStage=50&pipelineId=${encodeURIComponent(selected.id)}`,
  );
  if (!data) return <Unavailable />;

  return (
    <>
      <PageHeader title="Deals" context="Pipeline" />
      {savedViews}
      {toolbar}
      <p className="-mt-2 text-sm text-text-muted">
        Drag a card to move it, or open one to edit. On a phone, tap a card and pick a stage.
      </p>
      {picker}
      {archivedNote}
      <DealsBoard
        columns={data.columns}
        stages={data.stages}
        staleAfterDays={normaliseStaleAfterDays(data.staleAfterDays ?? staleAfterDays)}
      />
    </>
  );
}

/**
 * Board | Table. Two links, not a client toggle: the view is URL state like
 * everything else on the page, so it survives a refresh and a shared link.
 */
function ViewToggle({ state }: { state: DealsState }) {
  const option = (view: DealsState["view"], label: string, Icon: typeof LayoutGrid) => {
    const active = state.view === view;
    return (
      <Link
        href={dealsHref(state, { view })}
        aria-current={active ? "true" : undefined}
        className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors duration-150 ease-out ${
          active ? "bg-text text-bg" : "text-text-muted hover:bg-surface-hover hover:text-text"
        }`}
      >
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        {label}
      </Link>
    );
  };
  return (
    <nav aria-label="Deals view" className="inline-flex rounded-full border border-border-strong bg-surface p-0.5">
      {option("board", "Board", LayoutGrid)}
      {option("table", "Table", Rows3)}
    </nav>
  );
}

function Unavailable() {
  return (
    <>
      <PageHeader title="Deals" context="Pipeline" />
      <Card>
        <MonoLabel>Data unavailable</MonoLabel>
        <p className="mt-2 text-sm text-text-muted">
          The platform API did not answer. If this persists, contact your provider.
        </p>
      </Card>
    </>
  );
}
