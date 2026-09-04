"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { GripVertical, Phone } from "lucide-react";
import { EmptyState, MonoLabel, useAlert } from "@aura/ui";
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
    emptyState,
    moveOnServer,
    renderDrawer,
  } = config;

  const findItem = (id: string) =>
    columns.flatMap((c) => c.items).find((item) => getId(item) === id) ?? null;

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

    setColumns((prev) =>
      prev.map((column) => {
        if (column.key === from) {
          return {
            ...column,
            count: Math.max(0, column.count - 1),
            value: column.value - (num(getValue(item)) ?? 0),
            items: column.items.filter((it) => getId(it) !== id),
          };
        }
        if (column.key === toStage) {
          return {
            ...column,
            count: column.count + 1,
            value: column.value + (num(getValue(item)) ?? 0),
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

    const result = await moveOnServer(id, toStage);
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
                {column.value > 0 ? (
                  <span className="text-xs text-text-muted tabular-nums">
                    {formatValue(column.value)}
                  </span>
                ) : null}
              </div>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums ${
                  // Won is the one stage worth marking in colour; lost is
                  // deliberately quiet rather than red, because a lost lead is
                  // a normal outcome and not an error to be flagged.
                  column.terminal === "won"
                    ? "border-transparent bg-success-subtle text-success-text"
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
                    className={`cursor-grab rounded-md border border-border bg-surface p-2.5 shadow-sm transition-opacity duration-150 ease-out active:cursor-grabbing ${
                      dragging === id ? "opacity-40" : ""
                    }`}
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
                      <span className="mt-1 block text-xs text-text-subtle">
                        {relativeTime(getLastActivityAt(item))}
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

      {renderDrawer({ open, onClose: () => setOpen(null), onChanged: patchOpen })}
    </>
  );
}
