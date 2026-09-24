"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { Button, Dialog, ErrorBanner, FormField, Input, MonoLabel, Select, useToast } from "@aura/ui";
import {
  StageListEditor,
  draftsFromStages,
  stagesFromDrafts,
  type StageDraft,
} from "@/components/stage-list-editor";
import { useRealtime } from "@/components/realtime-provider";
import { InlineListSkeleton } from "@/components/skeletons";
import {
  boardRef,
  type LeadBoard,
  type LeadBoardChannel,
  type LeadBoardGrants,
  type LeadBoardRoute,
  type LeadBoardRouteSource,
} from "../types";
import {
  createLeadBoardAction,
  deleteLeadBoardAction,
  fetchBoardRoutesAction,
  fetchLeadBoardsAction,
  saveBoardRoutesAction,
  updateLeadBoardAction,
} from "./actions";

type Tab = "boards" | "routing";

type View =
  | { kind: "list" }
  | { kind: "edit"; board: LeadBoard; name: string; rows: StageDraft[] }
  | { kind: "delete"; board: LeadBoard; moveTo: string };

/** A routing-table cell: "" inherits the channel's route, "main" or a board id. */
type RouteChoice = string;
const INHERIT = "";

const routeKey = (channel: LeadBoardChannel, sourceId: string | null) => `${channel}:${sourceId ?? "*"}`;

const TAB_CLASS = (active: boolean) =>
  `h-9 flex-1 rounded-md border text-sm font-medium transition-colors duration-150 ease-out ${
    active
      ? "border-accent bg-accent-subtle text-accent-text"
      : "border-border bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
  }`;

/**
 * "Manage boards" (0136): make, reshape and delete lead boards, and decide
 * which channel's new leads land on which board.
 *
 * Two tabs rather than two dialogs, because the two questions are asked
 * together - "I made a Website board; now send the website's leads to it".
 *
 * ── BOARDS ──────────────────────────────────────────────────────────────────
 *
 * A new board starts as a copy of the Main board's columns - the common case
 * is "the same pipeline, for a different stream of leads" - and opens straight
 * into its column editor so it can be reshaped before anything lands on it.
 * Columns are edited with the same editor, and the same rules, as the deal
 * board's Manage board: a column holding leads cannot be removed, and a
 * rename keeps the column's identity.
 *
 * Deleting a board moves its leads to another board first, and the person
 * picks which one - nothing is ever deleted with the board. The Main board
 * cannot be deleted: every channel without a route lands there.
 *
 * ── ROUTING ─────────────────────────────────────────────────────────────────
 *
 * One row per source, one board per row, so a source can never point at two
 * boards and "where does a WhatsApp enquiry go?" is answered by reading one
 * line. A specific number or form either follows its channel's row ("Same as
 * all ...") or overrides it - including back to the Main board.
 *
 * Every control respects the permission grid: the API answers `can` with
 * exactly the lead_board cells this person holds, and a button the API would
 * refuse is not offered.
 */
export function ManageLeadBoardsDialog({ grants }: { grants: LeadBoardGrants }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("boards");
  const [view, setView] = useState<View>({ kind: "list" });
  const [boards, setBoards] = useState<LeadBoard[] | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [sources, setSources] = useState<{
    whatsapp: LeadBoardRouteSource[];
    web_form: LeadBoardRouteSource[];
  } | null>(null);
  const [routes, setRoutes] = useState<Record<string, RouteChoice>>({});

  const load = async () => {
    const result = await fetchLeadBoardsAction();
    if (result.error) setError(`Couldn't load the boards: ${result.error}`);
    setBoards(result.boards ?? []);
    return result.boards ?? [];
  };

  useEffect(() => {
    if (!open) return;
    setTab("boards");
    setView({ kind: "list" });
    setError(null);
    setBoards(null);
    setSources(null);
    void load();
  }, [open]);

  // Somebody else adding, reshaping or deleting a board while this is open.
  // Only the list view reloads: an open editor or delete confirmation keeps
  // the board it was opened with rather than changing under the person.
  useRealtime(["lead-board", "lead"], () => {
    if (open && tab === "boards" && view.kind === "list" && !pending) void load();
  });

  useEffect(() => {
    if (!open || tab !== "routing" || sources !== null) return;
    void fetchBoardRoutesAction().then((r) => {
      if (r.error) setError(`Couldn't load the routing: ${r.error}`);
      setSources(r.sources ?? { whatsapp: [], web_form: [] });
      const next: Record<string, RouteChoice> = {};
      for (const route of r.routes ?? []) next[routeKey(route.channel, route.sourceId)] = boardRef(route.boardId);
      setRoutes(next);
    });
  }, [open, tab, sources]);

  const afterWrite = () => router.refresh();

  // ── Boards ────────────────────────────────────────────────────────────────

  const createBoard = () => {
    setError(null);
    const name = newName.trim();
    if (!name) return setError("Give the new board a name.");
    startTransition(async () => {
      const result = await createLeadBoardAction(name);
      if (result.error || !result.id) return setError(result.error ?? "The board wasn't created.");
      setNewName("");
      const fresh = await load();
      afterWrite();
      const board = fresh.find((b) => b.id === result.id);
      // Straight into its columns: a copy of Main is a starting point.
      if (board) setView({ kind: "edit", board, name: board.name, rows: draftsFromStages(board.stages) });
      toast(`Board "${name}" created`);
    });
  };

  const saveBoard = (v: Extract<View, { kind: "edit" }>) => {
    setError(null);
    const name = v.name.trim();
    if (!name) return setError("The board needs a name.");
    const result = stagesFromDrafts(v.rows);
    if ("error" in result) return setError(result.error);
    startTransition(async () => {
      const saved = await updateLeadBoardAction(boardRef(v.board.id), { name, stages: result.stages });
      if (saved.error) return setError(saved.error);
      await load();
      afterWrite();
      setView({ kind: "list" });
      toast(`"${name}" saved`);
    });
  };

  const deleteBoard = (v: Extract<View, { kind: "delete" }>) => {
    setError(null);
    if (!v.board.id) return;
    const boardId = v.board.id;
    startTransition(async () => {
      const result = await deleteLeadBoardAction(boardId, v.moveTo);
      if (result.error) return setError(result.error);
      await load();
      setSources(null); // its routes went with it
      afterWrite();
      setView({ kind: "list" });
      const moved = result.leadsMoved ?? 0;
      toast(
        moved > 0
          ? `"${v.board.name}" deleted - ${moved} lead${moved === 1 ? "" : "s"} moved`
          : `"${v.board.name}" deleted`,
      );
    });
  };

  // ── Routing ───────────────────────────────────────────────────────────────

  const saveRouting = () => {
    setError(null);
    const payload: LeadBoardRoute[] = [];
    for (const [key, choice] of Object.entries(routes)) {
      const [channel, source] = key.split(":") as [LeadBoardChannel, string];
      const sourceId = source === "*" ? null : source;
      // A whole-channel row set to Main is the default and needs no row; a
      // specific row set to "Same as all" inherits and needs none either.
      if (choice === INHERIT) continue;
      if (sourceId === null && choice === "main") continue;
      payload.push({ channel, sourceId, boardId: choice === "main" ? null : choice });
    }
    startTransition(async () => {
      const result = await saveBoardRoutesAction(payload);
      if (result.error) return setError(result.error);
      afterWrite();
      toast("Routing saved - new leads follow it from now on");
    });
  };

  // ── Rendering ─────────────────────────────────────────────────────────────

  const boardOptions = (boards ?? []).map((b) => (
    <option key={boardRef(b.id)} value={boardRef(b.id)}>
      {b.name}
    </option>
  ));

  const routeRow = (
    channel: LeadBoardChannel,
    sourceId: string | null,
    label: string,
    note?: string,
    inheritLabel?: string,
  ) => {
    const key = routeKey(channel, sourceId);
    const value = routes[key] ?? (sourceId === null ? "main" : INHERIT);
    return (
      <li key={key} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className={`truncate text-sm ${sourceId === null ? "font-medium text-text" : "text-text"}`}>{label}</p>
          {note ? <p className="text-xs text-text-muted">{note}</p> : null}
        </div>
        <Select
          aria-label={`Board for ${label}`}
          value={value}
          onChange={(e) => setRoutes((prev) => ({ ...prev, [key]: e.target.value }))}
          className="sm:w-60"
        >
          {inheritLabel ? <option value={INHERIT}>{inheritLabel}</option> : null}
          {boardOptions}
        </Select>
      </li>
    );
  };

  const routingSection = (
    title: string,
    channel: Exclude<LeadBoardChannel, "manual">,
    list: LeadBoardRouteSource[],
    allLabel: string,
    empty: string,
  ) => (
    <section>
      <MonoLabel>{title}</MonoLabel>
      <ul className="mt-1 divide-y divide-border">
        {routeRow(channel, null, allLabel)}
        {list.map((s) => routeRow(channel, s.id, s.label, s.active ? undefined : "Paused", `Same as ${allLabel.toLowerCase()}`))}
      </ul>
      {list.length === 0 ? <p className="text-xs text-text-muted">{empty}</p> : null}
    </section>
  );

  const listView = (
    <div className="space-y-4">
      {boards === null ? (
        <InlineListSkeleton rows={3} />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {boards.map((b) => (
            <li key={boardRef(b.id)} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{b.name}</p>
                <p className="text-xs text-text-muted">
                  {b.leadCount} lead{b.leadCount === 1 ? "" : "s"} · {b.stages.length} column
                  {b.stages.length === 1 ? "" : "s"}
                  {b.id === null ? " · where unrouted leads land" : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {grants.editBoards ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setError(null);
                      setView({ kind: "edit", board: b, name: b.name, rows: draftsFromStages(b.stages) });
                    }}
                    aria-label={`Edit ${b.name}`}
                  >
                    <Pencil aria-hidden="true" className="h-4 w-4" />
                    Edit
                  </Button>
                ) : null}
                {grants.deleteBoards && b.id !== null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setError(null);
                      setView({ kind: "delete", board: b, moveTo: "main" });
                    }}
                    aria-label={`Delete ${b.name}`}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {grants.createBoard ? (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <FormField label="New board" name="new-board-name" hint="Starts with the Main board's columns">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createBoard();
                  }
                }}
                placeholder="e.g. Website enquiries"
                maxLength={60}
              />
            </FormField>
          </div>
          <Button onClick={createBoard} loading={pending} disabled={!newName.trim()}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Create
          </Button>
        </div>
      ) : null}
    </div>
  );

  let body: ReactNode;
  let footer: ReactNode;
  let description = "Make boards for different streams of leads, and choose where new leads land.";

  if (tab === "routing") {
    description = "New leads from each channel land on the board you pick here. Leads already on a board stay put.";
    body =
      sources === null || boards === null ? (
        <InlineListSkeleton rows={5} />
      ) : (
        <div className="space-y-5">
          {routingSection("WhatsApp", "whatsapp", sources.whatsapp, "All WhatsApp numbers", "No WhatsApp numbers are connected yet.")}
          {routingSection("Web forms", "web_form", sources.web_form, "All web forms", "No web forms are set up yet.")}
          <section>
            <MonoLabel>Added in the console</MonoLabel>
            <ul className="mt-1 divide-y divide-border">
              {routeRow("manual", null, "Added manually", "The New lead button, when no board is picked")}
            </ul>
          </section>
          <p className="text-xs text-text-muted">
            Calls, missed calls, ads and every other channel land on the Main board.
          </p>
        </div>
      );
    footer = (
      <>
        <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
          Close
        </Button>
        <Button onClick={saveRouting} loading={pending} disabled={sources === null}>
          Save routing
        </Button>
      </>
    );
  } else if (view.kind === "edit") {
    description = `Rename "${view.board.name}", and rename, reorder, add or remove its columns.`;
    body = (
      <div className="space-y-4">
        <FormField label="Board name" name="board-name">
          <Input
            value={view.name}
            onChange={(e) => setView({ ...view, name: e.target.value })}
            maxLength={60}
          />
        </FormField>
        <div>
          <MonoLabel>Columns</MonoLabel>
          <div className="mt-1.5">
            <StageListEditor
              rows={view.rows}
              setRows={(update) =>
                setView((v) =>
                  v.kind === "edit"
                    ? { ...v, rows: typeof update === "function" ? update(v.rows) : update }
                    : v,
                )
              }
              counts={view.board.counts}
              noun="lead"
            />
          </div>
        </div>
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={() => setView({ kind: "list" })} disabled={pending}>
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Back
        </Button>
        <Button onClick={() => saveBoard(view)} loading={pending}>
          Save board
        </Button>
      </>
    );
  } else if (view.kind === "delete") {
    const n = view.board.leadCount;
    description = `Delete "${view.board.name}". Nothing on it is lost.`;
    body = (
      <div className="space-y-4">
        <p className="text-sm text-text">
          {n === 0
            ? "This board has no leads, so nothing needs to move."
            : `Its ${n} lead${n === 1 ? "" : "s"} will move to the board you pick. Each keeps its column when that board has the same one, and otherwise starts in its first column.`}
        </p>
        <FormField label="Move its leads to" name="delete-move-to">
          <Select value={view.moveTo} onChange={(e) => setView({ ...view, moveTo: e.target.value })}>
            {(boards ?? [])
              .filter((b) => b.id !== view.board.id)
              .map((b) => (
                <option key={boardRef(b.id)} value={boardRef(b.id)}>
                  {b.name}
                </option>
              ))}
          </Select>
        </FormField>
        <p className="text-xs text-text-muted">Channels routed to this board will send new leads to the Main board.</p>
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={() => setView({ kind: "list" })} disabled={pending}>
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Back
        </Button>
        <Button variant="danger" onClick={() => deleteBoard(view)} loading={pending}>
          Delete board
        </Button>
      </>
    );
  } else {
    body = listView;
    footer = (
      <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
        Close
      </Button>
    );
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Settings2 aria-hidden="true" className="h-4 w-4" />
        Manage boards
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        title="Manage boards"
        description={description}
        footer={footer}
      >
        <div className="space-y-4">
          {grants.editBoards && view.kind === "list" ? (
            <div role="tablist" aria-label="Manage boards" className="flex gap-2">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "boards"}
                onClick={() => {
                  setTab("boards");
                  setError(null);
                }}
                className={TAB_CLASS(tab === "boards")}
              >
                Boards
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "routing"}
                onClick={() => {
                  setTab("routing");
                  setError(null);
                }}
                className={TAB_CLASS(tab === "routing")}
              >
                Routing
              </button>
            </div>
          ) : null}

          {body}

          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        </div>
      </Dialog>
    </>
  );
}
