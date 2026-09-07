import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import type { FollowupCounts, Task } from "../types";
import { FollowupQueue, type Bucket } from "./followup-queue";

export const metadata: Metadata = { title: "Follow-ups - Aura" };

const BUCKETS: Bucket[] = ["all", "overdue", "today", "upcoming", "completed"];

/**
 * The follow-up queue (migration 0095).
 *
 * ── WHY THE DEFAULT TAB IS OVERDUE ──────────────────────────────────────────
 *
 * Not "all". A queue's landing view should be the part that is already going
 * wrong, because that is the only bucket where opening the page changes an
 * outcome - everything else is a list somebody will reach in due course. The
 * tenant this was modelled on had 1,060 of 1,179 follow-ups overdue, and part
 * of the reason nobody knew is that their default tab was All.
 *
 * ── THE TABS AND THE ROWS ARE TWO REQUESTS, ON PURPOSE ──────────────────────
 *
 * `GET /v1/tasks/counts` returns all five totals in one statement, and the
 * list returns one page of rows. They could be one endpoint, and then every
 * tab switch would recompute five aggregates to render fifty rows. Kept apart,
 * the counts are one cheap query per page load and the rows paginate freely.
 *
 * Both are narrowed by the same record scope server-side, so a telecaller's
 * badge and a telecaller's list are counting the same thing - a badge that
 * disagrees with the page under it is worse than no badge.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ bucket?: string }>;
}) {
  const { bucket: bucketParam } = await searchParams;
  const bucket: Bucket = BUCKETS.includes(bucketParam as Bucket)
    ? (bucketParam as Bucket)
    : "overdue";

  const [list, counts] = await Promise.all([
    ownerGet<{ tasks: Task[]; total: number }>(`/v1/tasks?bucket=${bucket}&limit=100`),
    ownerGet<FollowupCounts>("/v1/tasks/counts"),
  ]);

  if (list === null) {
    return (
      <>
        <PageHeader title="Follow-ups" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  // Today as the SERVER sees it, passed down rather than computed in the
  // browser. Otherwise the client's clock decides what "overdue" looks like,
  // and a rep whose laptop is set to the wrong day sees a different queue from
  // the one the API counted.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader title="Follow-ups" context="Pipeline" />
      <p className="-mt-2 max-w-prose text-sm leading-relaxed text-text-muted">
        A promise to contact somebody at a time. Overdue ones are chased once a day in the
        console&rsquo;s own notifications — the person who owes the follow-up, never the customer.
      </p>

      <FollowupQueue
        initial={list.tasks}
        counts={counts ?? { all: 0, overdue: 0, today: 0, upcoming: 0, completed: 0 }}
        bucket={bucket}
        today={today}
      />
    </>
  );
}
