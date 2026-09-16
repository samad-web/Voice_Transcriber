"use client";

import { useState } from "react";
import { EmptyState, useAlert, useToast } from "@aura/ui";
import type { ReviewItem } from "@/lib/review-queue";
import { DuplicateReviewCard } from "./duplicate-review-card";
import { OptOutReviewCard } from "./opt-out-review-card";
import { WhatsAppReviewCard } from "./whatsapp-review-card";

/**
 * The cards, and the one piece of state the queue owns: which items are gone.
 *
 * A decided card is removed locally the moment its action succeeds. No
 * `router.refresh()`: refreshing inside an action's transition while the
 * component that started it unmounts stalled the router in Phase 5, and the
 * next navigation to this page fetches fresh anyway.
 */
export function ReviewList({
  items,
  waiting,
  emptyTitle,
  emptyDescription,
}: {
  items: ReviewItem[];
  /** Keyed by item id. */
  waiting: Record<string, string>;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  const alert = useAlert();
  const toast = useToast();

  const onResolved = (id: string, message: string) => {
    setResolved((prev) => new Set(prev).add(id));
    toast(message);
  };
  const onFailed = (title: string, detail: string) => {
    void alert({ title, body: detail, tone: "danger" });
  };

  const visible = items.filter((item) => !resolved.has(item.id));
  if (visible.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <ul className="space-y-3" aria-label="Items waiting for review">
      {visible.map((item) => {
        const common = { waiting: waiting[item.id] ?? "", onResolved, onFailed };
        return (
          <li key={`${item.source}:${item.id}`}>
            {item.source === "whatsapp" ? (
              <WhatsAppReviewCard item={item.qualification} {...common} />
            ) : item.source === "opt_outs" ? (
              <OptOutReviewCard item={item.optOut} {...common} />
            ) : (
              <DuplicateReviewCard item={item.duplicate} {...common} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
