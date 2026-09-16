import "server-only";
import { Card, MonoLabel } from "@aura/ui";
import type { getOwner } from "@/lib/owner-context";
import {
  REVIEW_SOURCES,
  orderReviewItems,
  reviewHref,
  reviewSourceSpec,
  waitingFor,
  type ReviewFilter,
} from "@/lib/review-queue";
import { FilterLink } from "../filter-link";
import { ReviewList } from "./review-list";
import { loadReviewQueue } from "./sources";

type Owner = NonNullable<Awaited<ReturnType<typeof getOwner>>>;

/**
 * The review queue, as a section any page can render.
 *
 * `/owner/review` renders it with the source tabs; `/owner/whatsapp-leads`
 * renders it pinned to one source with no tabs - one queue component, so the
 * two screens cannot drift into two definitions of approving a lead.
 */
export async function ReviewQueueSection({
  owner,
  filter,
  includeJunk,
  base,
  showTabs,
}: {
  owner: Owner;
  filter: ReviewFilter;
  includeJunk: boolean;
  /** The page these links stay on. */
  base: string;
  showTabs: boolean;
}) {
  const data = await loadReviewQueue(owner, { includeJunk });
  const items = orderReviewItems(data.items, filter);
  const now = new Date();
  const waiting = Object.fromEntries(items.map((i) => [i.id, waitingFor(i.waitingSince, now)]));
  const allTotal = data.available.reduce((sum, key) => sum + (data.totals[key] ?? 0), 0);
  const brokenShown = data.unavailable.filter((key) => filter === "all" || key === filter);

  if (data.available.length === 0) {
    return (
      <Card>
        <MonoLabel>Nothing to review</MonoLabel>
        <p className="mt-2 text-sm text-text-muted">
          None of the review queues are switched on for your role in this workspace.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {showTabs || filter === "whatsapp" ? (
        <nav aria-label="Review sources" className="flex flex-wrap items-center gap-2">
          {showTabs ? (
            <>
              <FilterLink active={filter === "all"} href={reviewHref("all", { base })}>
                All · {allTotal}
              </FilterLink>
              {REVIEW_SOURCES.filter((s) => data.available.includes(s.key)).map((s) => (
                <FilterLink key={s.key} active={filter === s.key} href={reviewHref(s.key, { base })}>
                  {s.label} · {data.totals[s.key] ?? 0}
                </FilterLink>
              ))}
            </>
          ) : null}
          {filter === "whatsapp" ? (
            <FilterLink
              active={includeJunk}
              href={reviewHref(showTabs ? "whatsapp" : "all", { base, includeJunk: !includeJunk })}
            >
              {includeJunk ? "Hide junk" : "Include junk"}
            </FilterLink>
          ) : null}
        </nav>
      ) : null}

      {filter !== "all" ? (
        <p className="text-sm text-text-muted">{reviewSourceSpec(filter).blurb}</p>
      ) : (
        <p className="text-sm text-text-muted">
          Everything waiting for a person to decide, longest-waiting first. Nothing here sends a message.
        </p>
      )}

      {brokenShown.length > 0 ? (
        <p role="alert" className="rounded-md border border-border-strong px-3 py-2 text-sm text-text">
          Couldn&apos;t load {brokenShown.map((key) => reviewSourceSpec(key).label).join(", ")} right now.
          The rest of the queue is shown.
        </p>
      ) : null}

      <ReviewList
        // Remount when the view changes, so cards decided in one view do not
        // stay hidden after the filter brings the same ids back from the API.
        key={`${filter}:${includeJunk}`}
        items={items}
        waiting={waiting}
        emptyTitle="Nothing waiting for review"
        emptyDescription={
          filter === "whatsapp"
            ? "New WhatsApp threads from unknown numbers are scored within about fifteen minutes of their last message."
            : "When the system proposes a lead, flags a possible opt-out or finds a duplicate, it appears here."
        }
      />
    </div>
  );
}
