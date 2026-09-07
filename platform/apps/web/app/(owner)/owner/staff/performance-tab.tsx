import { Card, MonoLabel } from "@aura/ui";
import { ownerGet } from "@/lib/owner-context";
import { PerformanceTable } from "./performance-table";
import type { PerformanceResponse } from "./types";

/**
 * The staff scorecard.
 *
 * ── THE RANGE IS THE LAST 30 DAYS AND IT IS COMPUTED HERE ─────────────────
 *
 * On the SERVER, not in the browser. A range derived from the reader's clock
 * would give two people looking at the same link different numbers, and the
 * one whose laptop is a day out would quietly be reading a different month.
 * The API converts these dates using the org's own reporting timezone, so the
 * days are the business's days rather than the database's.
 */
export async function PerformanceTab() {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  const range = `from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`;

  const data = await ownerGet<PerformanceResponse>(`/v1/owner/staff/performance?${range}`);

  if (!data) {
    return (
      <Card>
        <MonoLabel>Data unavailable</MonoLabel>
        <p className="mt-2 text-sm text-text-muted">
          The platform API did not answer. If this persists, contact your provider.
        </p>
      </Card>
    );
  }

  const unlinked = data.staff.filter((row) => !row.linked);

  return (
    <>
      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
        The last 30 days ({data.from} to {data.to}). A dash means{" "}
        <strong className="font-medium text-text">not measured</strong>, never zero — see below.
      </p>

      <PerformanceTable rows={data.staff} />

      {unlinked.length > 0 ? (
        <Card className="space-y-2">
          <MonoLabel>Why some columns are dashes</MonoLabel>
          <p className="max-w-prose text-sm leading-relaxed text-text-muted">
            Calls and leads are recorded against a{" "}
            <strong className="font-medium text-text">handset identity</strong>; follow-ups and
            messages are recorded against a <strong className="font-medium text-text">login</strong>
            . {unlinked.length} {unlinked.length === 1 ? "person has" : "people have"} only one of
            the two here, so the other half of their row is not measured rather than zero.
          </p>
          <p className="max-w-prose text-sm leading-relaxed text-text-muted">
            Link the two on the Team tab and both halves fill in. Until then a dash is the honest
            answer: showing 0 calls for somebody whose handset was never linked would read as
            &ldquo;made no calls&rdquo;.
          </p>
        </Card>
      ) : null}
    </>
  );
}
