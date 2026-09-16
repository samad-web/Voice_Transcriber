"use client";

import { useState } from "react";
import { Button } from "@aura/ui";
import type { ReviewDuplicate } from "@/lib/review-queue";
import { dismissDuplicateAction, mergeRecordsAction } from "../crm-actions";
import { ReviewCardFrame, type ReviewCardProps } from "./review-card";

/**
 * Two records that may be one (merge API). Choosing which side to keep IS the
 * edit: the survivor keeps its own fields and absorbs the other's history, the
 * same default the Duplicates page uses, and a merge can be undone for 30 days.
 */
export function DuplicateReviewCard({ item, waiting, onResolved, onFailed }: ReviewCardProps<ReviewDuplicate>) {
  const [busy, setBusy] = useState<"a" | "b" | "dismiss" | null>(null);
  const noun = item.object_type === "contact" ? "contacts" : "accounts";

  const keep = async (side: "a" | "b") => {
    setBusy(side);
    const [survivor, victim] =
      side === "a" ? [item.record_a_id, item.record_b_id] : [item.record_b_id, item.record_a_id];
    const res = await mergeRecordsAction(item.object_type, survivor, victim);
    setBusy(null);
    if (res.error) return onFailed("Couldn't merge the records", res.error);
    const kept = side === "a" ? item.record_a_label : item.record_b_label;
    onResolved(item.id, `Merged into ${kept ?? "the record you kept"}`);
  };

  const dismiss = async () => {
    setBusy("dismiss");
    const res = await dismissDuplicateAction(item.id);
    setBusy(null);
    if (res.error) return onFailed("Couldn't dismiss the pair", res.error);
    onResolved(item.id, "Marked as not a duplicate");
  };

  const sides = [
    { key: "a" as const, label: item.record_a_label, detail: item.record_a_detail },
    { key: "b" as const, label: item.record_b_label, detail: item.record_b_detail },
  ];

  return (
    <ReviewCardFrame
      sourceLabel={`Duplicate ${noun}`}
      waiting={waiting}
      title={`${item.record_a_label ?? "Unnamed"} and ${item.record_b_label ?? "Unnamed"}`}
      meta={<span>matched on {item.match_reason.replace(/_/g, " ")}</span>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {sides.map((side) => (
          <div key={side.key} className="rounded-md border border-border p-3">
            <p className="font-medium break-words text-text">{side.label ?? "Unnamed"}</p>
            <p className="text-xs break-words text-text-muted">{side.detail ?? "-"}</p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-2"
              loading={busy === side.key}
              disabled={busy !== null}
              onClick={() => void keep(side.key)}
            >
              Keep this one
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          loading={busy === "dismiss"}
          disabled={busy !== null}
          onClick={() => void dismiss()}
        >
          Not a duplicate
        </Button>
      </div>
    </ReviewCardFrame>
  );
}
