"use client";

import { useState } from "react";
import { GripVertical, Phone } from "lucide-react";
import { EmptyState, MonoLabel } from "@aura/ui";
import { DealDrawer } from "../deal-drawer";
import { updateDealAction } from "../crm-actions";
import {
  formatValue,
  num,
  relativeTime,
  type Deal,
  type DealBoardColumn,
  type Stage,
} from "../types";

/**
 * The deal pipeline board — a near-clone of ../board/board.tsx (leads), same
 * native-HTML5-drag-and-drop / optimistic-update-with-rollback contract. See
 * that file's own comment for why the DnD is hand-rolled rather than a
 * library, and why every card is also a button (the touch-device path).
 */
export function DealsBoard({
  columns: initial,
  stages,
}: {
  columns: DealBoardColumn[];
  stages: Stage[];
}) {
  const [columns, setColumns] = useState(initial);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [open, setOpen] = useState<Deal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const findDeal = (dealId: string) =>
    columns.flatMap((c) => c.deals).find((d) => d.id === dealId) ?? null;

  const applyLocal = (dealId: string, toStage: string): string | null => {
    const deal = findDeal(dealId);
    if (!deal || deal.stage === toStage) return null;
    const from = deal.stage;
    const moved = { ...deal, stage: toStage };

    setColumns((prev) =>
      prev.map((column) => {
        if (column.key === from) {
          return {
            ...column,
            count: Math.max(0, column.count - 1),
            value: column.value - (num(deal.amount) ?? 0),
            deals: column.deals.filter((d) => d.id !== dealId),
          };
        }
        if (column.key === toStage) {
          return {
            ...column,
            count: column.count + 1,
            value: column.value + (num(deal.amount) ?? 0),
            deals: [moved, ...column.deals],
          };
        }
        return column;
      }),
    );
    return from;
  };

  const move = async (dealId: string, toStage: string) => {
    setError(null);
    const from = applyLocal(dealId, toStage);
    if (!from) return;

    const result = await updateDealAction(dealId, { stage: toStage });
    if (result.error) {
      applyLocal(dealId, from);
      setError(result.error);
      return;
    }
    if (result.deal?.status) {
      setColumns((prev) =>
        prev.map((column) => ({
          ...column,
          deals: column.deals.map((d) =>
            d.id === dealId ? { ...d, status: result.deal!.status as Deal["status"] } : d,
          ),
        })),
      );
    }
  };

  const patchOpen = (dealId: string, update: Partial<Deal>) => {
    setColumns((prev) =>
      prev.map((column) => ({
        ...column,
        deals: column.deals.map((d) => (d.id === dealId ? { ...d, ...update } : d)),
      })),
    );
    if (update.stage) void applyLocal(dealId, update.stage);
    setOpen((current) => (current && current.id === dealId ? { ...current, ...update } : current));
  };

  const total = columns.reduce((n, c) => n + c.count, 0);

  return (
    <>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text"
        >
          {error}
        </p>
      ) : null}

      {total === 0 ? (
        <EmptyState
          title="No deals yet"
          description="Deals appear automatically alongside the lead board when a recorded call is transcribed and the AI agent extracts a usable enquiry, or when one is created by hand."
        />
      ) : null}

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
              const dealId = e.dataTransfer.getData("text/deal-id") || dragging;
              if (dealId) void move(dealId, column.key);
              setDragging(null);
            }}
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
              {column.deals.length === 0 ? (
                <p className="py-6 text-center text-xs text-text-subtle">Empty</p>
              ) : null}

              {column.deals.map((deal) => (
                <article
                  key={deal.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/deal-id", deal.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(deal.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={`cursor-grab rounded-md border border-border bg-surface p-2.5 shadow-sm transition-opacity duration-150 ease-out active:cursor-grabbing ${
                    dragging === deal.id ? "opacity-40" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setOpen(deal)}
                    className="w-full rounded-sm text-left"
                    aria-label={`Open ${deal.name}`}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical
                        aria-hidden="true"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-subtle"
                      />
                      <span className="min-w-0 text-sm font-medium leading-snug break-words text-text">
                        {deal.name}
                      </span>
                    </div>

                    {deal.next_action ? (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-text-muted">
                        {deal.next_action}
                      </p>
                    ) : deal.summary ? (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-text-muted">
                        {deal.summary}
                      </p>
                    ) : null}

                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
                      <span className="truncate text-xs text-text-muted">
                        {deal.account_name ?? deal.contact_name ?? "no contact"}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {deal.call_count > 1 ? (
                          <span className="flex items-center gap-0.5 text-xs text-text-muted tabular-nums">
                            <Phone aria-hidden="true" className="h-3 w-3" />
                            {deal.call_count}
                          </span>
                        ) : null}
                        {num(deal.amount) === null ? null : (
                          <span className="text-xs font-medium text-text tabular-nums">
                            {formatValue(deal.amount)}
                          </span>
                        )}
                      </span>
                    </div>
                    <span className="mt-1 block text-xs text-text-subtle">
                      {relativeTime(deal.last_activity_at)}
                    </span>
                  </button>
                </article>
              ))}

              {column.count > column.deals.length ? (
                <MonoLabel className="text-center py-2">
                  +{column.count - column.deals.length} more
                </MonoLabel>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <DealDrawer deal={open} stages={stages} onClose={() => setOpen(null)} onChanged={patchOpen} />
    </>
  );
}
