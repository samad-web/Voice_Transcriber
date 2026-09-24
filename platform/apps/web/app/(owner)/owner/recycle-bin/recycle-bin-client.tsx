"use client";

import { useState, useTransition } from "react";
import { useServerState } from "@/lib/use-server-state";
import { Undo2 } from "lucide-react";
import { Button, Card, EmptyState, MonoLabel, StatusChip, useAlert, useToast } from "@aura/ui";
import { RECYCLE_BIN, daysUntilPurge } from "@aura/shared";
import { Time } from "@/components/org-time";
import { restoreAction, type BinItem, type BinResponse } from "./actions";

/**
 * ── WHY THE COUNTDOWN IS PER ROW AND NOT ONE LINE AT THE TOP ──────────────
 *
 * Everything here is on its own clock, because the window runs from when each
 * row was deleted. "Kept for 30 days" at the top of the page would be true and
 * useless: the question a person opens this page with is whether the thing they
 * are looking for is still here, and the answer is a number next to it.
 */
export function RecycleBinClient({ data }: { data: BinResponse }) {
  const [pending, startTransition] = useTransition();
  const [items, setItems] = useServerState(data.items, pending);
  const [busy, setBusy] = useState<string | null>(null);
  const alert = useAlert();
  const toast = useToast();

  const restore = (item: BinItem) => {
    setBusy(item.id);
    startTransition(async () => {
      const result = await restoreAction(item.resource, item.id);
      setBusy(null);
      if (result.error) {
        await alert({ title: "Couldn't restore it", body: result.error, tone: "danger" });
        return;
      }
      // Drop it from the list rather than re-reading: the row has left the bin,
      // and a refetch would flash the whole table for one removal.
      setItems((current) => current.filter((i) => i.id !== item.id));
      toast(`${RECYCLE_BIN[item.resource].label} restored`);
    });
  };

  if (items.length === 0) {
    return (
      <Card className="mt-6">
        <EmptyState
          icon={<Undo2 aria-hidden className="h-6 w-6" />}
          title="Nothing has been deleted"
          description={`Anything your team removes shows up here for ${data.retentionDays} days, with whatever was attached to it, so a delete is never the end of the story.`}
        />
      </Card>
    );
  }

  return (
    <Card className="mt-6">
      <MonoLabel>Deleted, newest first</MonoLabel>
      <ul className="mt-4 divide-y divide-border">
        {items.map((item) => {
          const spec = RECYCLE_BIN[item.resource];
          const left = daysUntilPurge(new Date(item.deletedAt));
          return (
            <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text">
                    {item.name || `Unnamed ${spec.label.toLowerCase()}`}
                  </span>
                  <StatusChip tone="muted">{spec.label}</StatusChip>
                </div>
                <p className="mt-0.5 text-xs text-text-muted">
                  Deleted <Time iso={item.deletedAt} mode="date" />
                  {item.deletedBy ? ` by ${item.deletedBy}` : ""}
                  {spec.carries ? ` · still holds ${spec.carries}` : ""}
                  {" · "}
                  {left === 0
                    ? "removed for good shortly"
                    : `${left} day${left === 1 ? "" : "s"} left`}
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => restore(item)}
                disabled={pending && busy === item.id}
              >
                <Undo2 aria-hidden className="mr-1 h-4 w-4" />
                Restore
              </Button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
