"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { GripVertical, Hourglass, Phone } from "lucide-react";
import { EmptyState, MonoLabel, useAlert } from "@aura/ui";
import { useFocusParam } from "../lib/use-focus-param";
import { formatValue, num, relativeTime } from "../types";

/**
 * Generic pipeline board shared by the lead board (./board.tsx) and the deal
 * board (../deals/deals-board.tsx) - the two used to be near-verbatim copies
 * of the same optimistic drag-and-drop kanban, differing only in which record
 * type (Lead vs Deal) rode in the cards. This file owns the mechanics; each
 * caller supplies a small `KanbanBoardConfig<T>` of accessors plus its own
 * PATCH action and drawer.
 *
 * Drag-and-drop is the browser's own HTML5 API rather than a library: a card
 * carries its record id, a column accepts the drop and the move is applied
 * optimistically, then confirmed by the server action. If the API rejects it
 * the card returns to where it was and the reason is raised in a dialog - a
 * card that silently snaps back with no explanation is the worst version of
 * this, and text below the fold is barely better.
 *
 * Every card is also a button that opens the drawer, where the same move can
 * be made by tapping a stage. That is the path on touch devices, where HTML5
 * drag events do not fire.
 */
export interface KanbanColumn<T> {
  key: string;
  label: string;
  terminal?: "won" | "lost";
  count: number;
  value: number;
  /**
   * How many records in the WHOLE column are stale, from the API - not just
   * the top N cards loaded here, which is why it is not counted client-side.
   * Omitted when the board has no stale rule.
   */
  staleCount?: number;
  items: T[];
}

export interface KanbanBoardConfig<T> {
  getId: (item: T) => string;
  /** Numeric value backing the column subtotal and the card's value chip. */
  getValue: (item: T) => string | number | null;
  getTitle: (item: T) => string;
  /** The line identifying who/what the card is with (telecaller, account…). */
  getSubtitle: (item: T) => string;
  /** Optional secondary line - next action, falling back to a summary. */
  getSecondary: (item: T) => string | null;
  getCallCount: (item: T) => number;
  getLastActivityAt: (item: T) => string;
  /** The dataTransfer key used to carry the dragged card's id. */
  dragDataKey: string;
  /**
   * An optional label under the card heading - the lead board uses it for the
   * project chip. Kept generic rather than a `project` field because the deal
   * board shares this file and will want something of its own here.
   */
  renderBadge?: (item: T) => ReactNode;
  /**
   * Fetch one record for a `?focus=<id>` deep link (global search, a
   * notification) when it is not among the cards this board loaded - a column
   * only carries its top N. Omitted, a focus id not on the board opens nothing.
   */
  loadFocused?: (id: string) => Promise<T | null>;
  /**
   * Days without activity when this card is stale, else null (lib/deal-staleness.ts).
   * Omitted, no card is ever flagged - the lead board has no stale rule yet.
   */
  getStaleDays?: (item: T) => number | null;
  emptyState: { title: string; description: string };
  /**
   * PATCH the stage on the server. Returns the merged record on success so
   * the relocated card can carry server-recalculated fields (e.g. status)
   * instead of the optimistic guess.
   */
  moveOnServer: (id: string, stage: string) => Promise<{ error?: string; record?: Partial<T> }>;
  /** The drawer for a card, rendered once per board. */
  renderDrawer: (props: {
    open: T | null;
    onClose: () => void;
    onChanged: (id: string, update: Partial<T>) => void;
  }) => ReactNode;
}

export function KanbanBoard<T extends { stage: string }>({
  columns: initial,
  config,
}: {
  columns: KanbanColumn<T>[];
  config: KanbanBoardConfig<T>;
}) {
  const [columns, setColumns] = useState(initial);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [open, setOpen] = useState<T | null>(null);
  const alert = useAlert();
  /** Moves this board has sent but not yet had confirmed. */
  const inFlight = useRef(0);

  /*
   * FOLLOW THE SERVER, BUT NOT OVER SOMEBODY'S HANDS.
   *
   * `useState(initial)` seeds once and then owns the board, which was fine
   * while the only way to get new props was a navigation that remounted this
   * component. It is not fine now: the console re-renders itself whenever
   * anything changes (components/realtime-provider.tsx), and without this the
   * board would be the one page that never moved - a colleague's card landing
   * in a column nobody watching this screen could see.
   *
   * The three guards are the whole subtlety, and each of them is a real way to
   * ruin somebody's afternoon:
   *
   *   dragging - re-seeding mid-drag pulls the card out of the cursor.
   *   open     - the drawer renders from the item it was opened with; swapping
   *              the collection underneath it closes or blanks the drawer
   *              somebody is halfway through editing.
   *   inFlight - between an optimistic move and the server confirming it, the
   *              props still say the card is in its old column. Re-seeding
   *              there would snap it back, and it would jump forward again on
   *              the next refresh. The most visible bug of the three.
   */
  useEffect(() => {
    if (dragging || open || inFlight.current > 0) return;
    setColumns(initial);
  }, [initial, dragging, open]);

  const {
    getId,
    getValue,
    getTitle,
    getSubtitle,
    getSecondary,
    getCallCount,
    getLastActivityAt,
    dragDataKey,
    renderBadge,
    getStaleDays,
    emptyState,
    moveOnServer,
    renderDrawer,
  } = config;

  const findItem = (id: string) =>
    columns.flatMap((c) => c.items).find((item) => getId(item) === id) ?? null;

  // Deep link: ?focus=<id> opens that card's drawer (../lib/use-focus-param.ts).
  const { clearFocus } = useFocusParam<T>({
    findLoaded: findItem,
    load: config.loadFocused,
    open: setOpen,
  });
  const closeDrawer = () => {
    setOpen(null);
    clearFocus();
  };

  /**
   * Move a card between columns in local state, returning the previous
   * stage. `source`, when given, is used as the record to relocate instead
   * of the pre-render lookup from `findItem` - the caller passes the
   * just-merged record so a stage move from the drawer carries its
   * server-recalculated fields rather than a stale snapshot.
   */
  const applyLocal = (id: string, toStage: string, source?: T): string | null => {
    const item = source ?? findItem(id);
    if (!item || item.stage === toStage) return null;
    const from = item.stage;
    const moved = { ...item, stage: toStage } as T;
    // Moving a card IS activity - the deals PATCH stamps last_activity_at - so
    // a stale card leaves its column's stale count and joins no other. The
    // card's own flag clears when the server's record merges in below.
    const wasStale = getStaleDays ? getStaleDays(item) !== null : false;
    const shift = (column: KanbanColumn<T>, delta: number) =>
      column.staleCount === undefined || !wasStale || delta > 0
        ? column.staleCount
        : Math.max(0, column.staleCount + delta);

    setColumns((prev) =>
      prev.map((column) => {
        if (column.key === from) {
          return {
            ...column,
            count: Math.max(0, column.count - 1),
            value: column.value - (num(getValue(item)) ?? 0),
            staleCount: shift(column, -1),
            items: column.items.filter((it) => getId(it) !== id),
          };
        }
        if (column.key === toStage) {
          return {
            ...column,
            count: column.count + 1,
            value: column.value + (num(getValue(item)) ?? 0),
            staleCount: shift(column, 1),
            items: [moved, ...column.items],
          };
        }
        return column;
      }),
    );
    return from;
  };

  const move = async (id: string, toStage: string) => {
    const from = applyLocal(id, toStage);
    if (!from) return;

    inFlight.current += 1;
    let result: Awaited<ReturnType<typeof moveOnServer>>;
    try {
      result = await moveOnServer(id, toStage);
    } finally {
      // In a `finally`, so a thrown action cannot leave the counter stuck above
      // zero - which would silently switch this board's live updates off for
      // the rest of the session.
      inFlight.current -= 1;
    }

    if (result.error) {
      applyLocal(id, from);
      await alert({ title: "Couldn't move the card", body: result.error, tone: "danger" });
      return;
    }
    // The server decides won/lost from the stage; reflect it on the card.
    if (result.record) {
      setColumns((prev) =>
        prev.map((column) => ({
          ...column,
          items: column.items.map((it) => (getId(it) === id ? { ...it, ...result.record } : it)),
        })),
      );
    }
  };

  const patchOpen = (id: string, update: Partial<T>) => {
    // Captured while merging below, so a stage move can relocate the card
    // using the just-merged record (server-recalculated fields included)
    // rather than a stale pre-render lookup via findItem.
    let merged: T | null = null;
    setColumns((prev) =>
      prev.map((column) => ({
        ...column,
        items: column.items.map((it) => {
          if (getId(it) !== id) return it;
          merged = { ...it, ...update };
          return merged;
        }),
      })),
    );
    // A stage change from inside the drawer has to move the card too.
    if (update.stage) void applyLocal(id, update.stage, merged ?? undefined);
    setOpen((current) => (current && getId(current) === id ? { ...current, ...update } : current));
  };

  const total = columns.reduce((n, c) => n + c.count, 0);

  return (
    <>
      {total === 0 ? (
        <EmptyState title={emptyState.title} description={emptyState.description} />
      ) : null}

      {/* One horizontal scroller; columns keep a fixed width so a busy stage
          does not squeeze the rest of the board into slivers. */}
      <div className="flex gap-4 overflow-x-auto pb-4 -mx-1 px-1">
        {columns.map((column) => (
          <section
            key={column.key}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(column.key);
            }}
            onDragLeave={() => setOver((c) => (c === column.key ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData(dragDataKey) || dragging;
              if (id) void move(id, column.key);
              setDragging(null);
            }}
            // The drop target is a "selected" state, which doc 16 §1.1 lists as
            // a sanctioned accent use. It is also the only feedback a dragging
            // user gets, so it needs the accent border as well as the tint -
            // a tint alone is nearly invisible in dark mode.
            className={`flex w-[17rem] shrink-0 flex-col rounded-md border transition-colors duration-150 ease-out ${
              over === column.key
                ? "border-accent bg-accent-subtle"
                : "border-border bg-bg-subtle"
            }`}
          >
            <header className="flex items-center justify-between gap-2 rounded-t-md border-b border-border bg-surface px-3 py-2.5">
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium text-text">
                  {column.label}
                </span>
                {/* Always shown, zero included: an empty value line reads as
                    "not loaded", and a column worth nothing is worth knowing. */}
                <span className="flex items-center gap-2 text-xs text-text-muted tabular-nums">
                  <span>{formatValue(column.value)}</span>
                  {column.staleCount ? (
                    <span className="inline-flex items-center gap-0.5 text-warning-text">
                      <Hourglass aria-hidden="true" className="h-3 w-3" />
                      {column.staleCount} stale
                    </span>
                  ) : null}
                </span>
              </div>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums ${
                  // Three weights of NEUTRAL, not a hue. Won used to be green
                  // and lost was already deliberately quiet - but under the
                  // colour rule (@aura/ui's state.tsx) green means a call
                  // somebody answered, and these chips sit on a board a
                  // telecaller reads in the same glance as their call list.
                  // A stage is not a state. Won still leads the eye: it is
                  // the only inverted chip on the board.
                  column.terminal === "won"
                    ? "border-transparent bg-text text-bg"
                    : column.terminal === "lost"
                      ? "border-border bg-surface-hover text-text-muted"
                      : "border-border bg-surface text-text"
                }`}
              >
                {column.count}
              </span>
            </header>

            <div className="max-h-[calc(100dvh-16rem)] min-h-[8rem] flex-1 space-y-2 overflow-y-auto p-2">
              {column.items.length === 0 ? (
                <p className="py-6 text-center text-xs text-text-subtle">Empty</p>
              ) : null}

              {column.items.map((item) => {
                const id = getId(item);
                const title = getTitle(item);
                const secondary = getSecondary(item);
                const callCount = getCallCount(item);
                const value = getValue(item);
                const stale = getStaleDays ? getStaleDays(item) : null;
                return (
                  <article
                    key={id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(dragDataKey, id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={`cursor-grab rounded-md border bg-surface p-2.5 shadow-sm transition-opacity duration-150 ease-out active:cursor-grabbing ${
                      // A stale card carries a tinted edge as well as its chip,
                      // so a column of them can be scanned without reading.
                      stale !== null ? "border-warning-text/40" : "border-border"
                    } ${dragging === id ? "opacity-40" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => setOpen(item)}
                      className="w-full rounded-sm text-left"
                      aria-label={`Open ${title}`}
                    >
                      <div className="flex items-start gap-1.5">
                        <GripVertical
                          aria-hidden="true"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-subtle"
                        />
                        <span className="min-w-0 text-sm font-medium leading-snug break-words text-text">
                          {title}
                        </span>
                      </div>

                      {renderBadge ? (
                        // Above the summary, not below it: on a narrow column
                        // the summary is the part that gets clipped, and a
                        // label that only appears on wide screens is not a
                        // label anyone can rely on.
                        <span className="mt-1.5 flex">{renderBadge(item)}</span>
                      ) : null}

                      {secondary ? (
                        <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-text-muted">
                          {secondary}
                        </p>
                      ) : null}

                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
                        <span className="truncate text-xs text-text-muted">{getSubtitle(item)}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {callCount > 1 ? (
                            <span className="flex items-center gap-0.5 text-xs text-text-muted tabular-nums">
                              <Phone aria-hidden="true" className="h-3 w-3" />
                              {callCount}
                            </span>
                          ) : null}
                          {num(value) === null ? null : (
                            <span className="text-xs font-medium text-text tabular-nums">
                              {formatValue(value)}
                            </span>
                          )}
                        </span>
                      </div>
                      <span className="mt-1 flex items-center justify-between gap-2 text-xs text-text-subtle">
                        <span>{relativeTime(getLastActivityAt(item))}</span>
                        {stale !== null ? <StaleFlag days={stale} /> : null}
                      </span>
                    </button>
                  </article>
                );
              })}

              {column.count > column.items.length ? (
                <MonoLabel className="text-center py-2">
                  +{column.count - column.items.length} more
                </MonoLabel>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      {renderDrawer({ open, onClose: closeDrawer, onChanged: patchOpen })}
    </>
  );
}

/**
 * The "no activity in N days" flag. Icon, words and tint together - never the
 * tint alone - and in the WARNING ramp, which the colour rule leaves free:
 * red, green, blue and orange are call states (@aura/ui's state.tsx), and an
 * idle deal is none of them.
 */
export function StaleFlag({ days }: { days: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-subtle px-1.5 py-0.5 text-[11px] font-medium text-warning-text tabular-nums"
      title={`No activity for ${days} day${days === 1 ? "" : "s"}`}
    >
      <Hourglass aria-hidden="true" className="h-3 w-3" />
      <span aria-hidden="true">{days}d idle</span>
      <span className="sr-only">
        No activity for {days} day{days === 1 ? "" : "s"}
      </span>
    </span>
  );
}
