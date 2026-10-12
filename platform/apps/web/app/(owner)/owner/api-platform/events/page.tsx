import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { ReplayControls } from "./replay-controls";

export const metadata: Metadata = { title: "Event inspector" };

interface Events {
  events: {
    id: string;
    resource: string;
    external_id: string | null;
    status: "queued" | "processed" | "rejected";
    env: string;
    source: string;
    received_at: string;
    idempotency_key: string | null;
    payload: Record<string, unknown>;
    key_name: string | null;
    key_prefix: string | null;
    result_status: string | null;
    error: { code: string; message: string; field_errors?: { field: string; message: string }[] } | null;
    fact_table: string | null;
    fact_id: string | null;
  }[];
  nextBefore: string | null;
}

interface Errors {
  byReason: { code: string; count: number }[];
}

const STATUSES = ["", "queued", "processed", "rejected"] as const;

/**
 * §8.8's event inspector: every event you sent, what became of it, and why not.
 *
 * ── THIS IS WHAT AN APPEND-ONLY RAW STORE BUYS ──────────────────────────────
 *
 * The events table keeps every accepted item forever rather than only the
 * latest payload per id, which is what makes this page able to answer "what
 * exactly did we send at 14:02, and what did you do with it". Migration 0193's
 * header explains why that ruled out the unique key the original spec asked
 * for.
 *
 * It is also what makes REPLAY a one-column write: a rejected event goes back
 * to `queued` and the drain picks it up. The common case - "we rejected 1,400
 * calls because the telecaller did not exist yet" - is then fixed by creating
 * the person and pressing a button, instead of asking the customer to re-send
 * three weeks of data.
 *
 * ── BEHIND THE TENANT TIER, NOT A PERSONA ───────────────────────────────────
 *
 * A raw payload is the least redacted thing this tier stores, so §6.5 limits
 * it to Owner, Admin and Developer. The API gates it on `org_admin` - the tier
 * that already governs API keys - rather than on a fourth console persona. See
 * `insights-ops.controller.ts`.
 */
export default async function EventInspectorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/api-platform/events");
  await requireOwnerRoles(["owner"]);

  const sp = await searchParams;
  const status = typeof sp.status === "string" && STATUSES.includes(sp.status as never) ? sp.status : "";
  const resource = typeof sp.resource === "string" ? sp.resource : "";
  const externalId = typeof sp.externalId === "string" ? sp.externalId : "";

  // The cursor the API hands back as `nextBefore`, carried in the URL so a
  // page of the log is a link somebody can send to whoever owns the
  // integration. See the pager at the foot.
  const before = typeof sp.before === "string" ? sp.before : "";

  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (resource) query.set("resource", resource);
  if (externalId) query.set("externalId", externalId);
  if (before) query.set("before", before);
  // The API defaults to 50 and allows 200. 100 is a screen of log somebody can
  // scan without it becoming a page nobody scrolls to the end of.
  query.set("limit", "100");

  /** This page's URL with one parameter changed - for the pager's two links. */
  const pageHref = (cursor: string | null): string => {
    const next = new URLSearchParams();
    if (status) next.set("status", status);
    if (resource) next.set("resource", resource);
    if (externalId) next.set("externalId", externalId);
    if (cursor) next.set("before", cursor);
    const qs = next.toString();
    return qs ? `/owner/api-platform/events?${qs}` : "/owner/api-platform/events";
  };

  const [events, errors] = await Promise.all([
    ownerTry<Events>(`/v1/insights/events?${query.toString()}`),
    ownerTry<Errors>("/v1/insights/events/errors?limit=200"),
  ]);

  if (!events.ok) {
    return (
      <>
        <PageHeader title="Event inspector" context="API platform" />
        <LoadFailure failure={events} what="your events" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Event inspector"
        context="API platform"
        actions={
          <Link
            href="/owner/api-platform"
            className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
          >
            API platform
          </Link>
        }
      />
      <p className="-mt-2 text-sm text-text-muted">
        Everything your systems sent us, exactly as sent, and what it became.
      </p>

      <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
        {STATUSES.map((value) => {
          const active = value === status;
          const href = value
            ? `/owner/api-platform/events?status=${value}`
            : "/owner/api-platform/events";
          return (
            <Link
              key={value || "all"}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                active
                  ? "border-border-strong bg-surface-hover font-medium text-text"
                  : "border-border text-text-muted hover:bg-surface-hover"
              }`}
            >
              {value ? LABEL[value] : "All"}
            </Link>
          );
        })}
      </nav>

      {errors.ok && errors.data.byReason.length > 0 ? (
        <Card>
          <MonoLabel>Why things were rejected</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            Grouped, because &ldquo;1,400 rejected&rdquo; is not actionable and &ldquo;1,400:
            unknown telecaller&rdquo; is.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {errors.data.byReason.map((reason) => (
              <li key={reason.code} className="flex items-baseline justify-between gap-3">
                <code className="text-xs">{reason.code}</code>
                <span className="tabular-nums text-text-muted">
                  {reason.count.toLocaleString("en-IN")}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <ReplayControls reasons={errors.data.byReason} />
          </div>
        </Card>
      ) : null}

      {events.data.events.length === 0 ? (
        <EmptyState
          title="Nothing here"
          description={
            status
              ? "No events with that status."
              : "No events yet. The quickstart on the API platform page sends one in a single command."
          }
          action={
            <Link
              href="/owner/api-platform"
              className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
            >
              API platform
            </Link>
          }
        />
      ) : (
        <ul className="space-y-3">
          {events.data.events.map((event) => (
            <li key={event.id}>
              <Card>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={event.status === "rejected" ? "danger" : "muted"}>
                    {LABEL[event.status]}
                  </StatusChip>
                  <span className="text-sm font-medium text-text">{event.resource}</span>
                  {event.external_id ? (
                    <code className="rounded bg-surface-hover px-1.5 py-0.5 text-xs">
                      {event.external_id}
                    </code>
                  ) : null}
                  {event.env === "test" ? (
                    <StatusChip tone="outline">test</StatusChip>
                  ) : null}
                  <span className="ml-auto text-xs text-text-muted">
                    <LocalTime iso={event.received_at} />
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                  <span>
                    via {event.source === "import" ? "Excel import" : (event.key_name ?? "an API key")}
                    {event.key_prefix ? ` (${event.key_prefix}…)` : ""}
                  </span>
                  {event.idempotency_key ? (
                    <span>
                      idempotency <code>{event.idempotency_key}</code>
                    </span>
                  ) : null}
                  {event.fact_table ? <span>became a row in {event.fact_table}</span> : null}
                </div>

                {event.error ? (
                  <div className="mt-2 rounded-md border border-border bg-surface-hover p-2">
                    <p className="text-sm text-text">{event.error.message}</p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      <code>{event.error.code}</code>
                    </p>
                    {event.error.field_errors?.length ? (
                      <ul className="mt-1 space-y-0.5 text-xs text-text-muted">
                        {event.error.field_errors.map((fe) => (
                          <li key={fe.field}>
                            <code>{fe.field}</code>: {fe.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-accent-text underline-offset-2 hover:underline">
                    What you sent
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface-hover p-2 text-xs text-text">
                    <code>{JSON.stringify(event.payload, null, 2)}</code>
                  </pre>
                </details>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {/* ── The pager ──────────────────────────────────────────────────────
          The log is append-only and can run to millions of rows, so there is
          no total to count and no page number to jump to - the API pages it by
          cursor for exactly that reason ("an offset over a table that is being
          appended to re-reads rows the caller already saw").

          This used to render one request's worth and stop, with nothing to
          press: an inspector that could only ever show the newest 100 of
          4,000 events, and no way to tell that the rest existed. */}
      {events.data.nextBefore || before ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          {before ? (
            <Link href={pageHref(null)} className="underline underline-offset-2">
              ← Newest
            </Link>
          ) : (
            <span />
          )}
          {events.data.nextBefore ? (
            <Link href={pageHref(events.data.nextBefore)} className="underline underline-offset-2">
              Older →
            </Link>
          ) : (
            <span className="text-text-muted">That is the end of the log.</span>
          )}
        </div>
      ) : null}
    </>
  );
}

const LABEL: Record<string, string> = {
  queued: "Waiting",
  processed: "Counted",
  rejected: "Rejected",
};
