import Link from "next/link";
import { Card, MonoLabel, StatCard } from "@aura/ui";
import { ageFrom, hoursMinutes, money, pct, trendFromBp } from "./money";
import type { Commercial } from "./types";

/**
 * ROW 1 - THE BUSINESS, AND ROW 3 - WHETHER IT IS BEING DELIVERED.
 *
 * ── THE RULE EVERY TILE HERE FOLLOWS ────────────────────────────────────────
 *
 * A number, what it is a fraction of, and - where the measurement is weaker
 * than it looks - the fact that it is. Three of these are weaker than they
 * look, and each says so in its own second line rather than in a footnote
 * nobody reaches:
 *
 *   - Unsettled is not overdue. `billing_orders` has no due date.
 *   - Churn is a proxy. Nothing records when a tenant churned.
 *   - MRR excludes plans nobody has published a price for, and names how many.
 *
 * ── COLOUR ──────────────────────────────────────────────────────────────────
 *
 * `state="error"` is the console's ORANGE. Red is a missed call here and
 * nothing else (packages/ui/src/state.tsx, enforced by console-palette.test.ts),
 * so a commercial problem - unsettled cash, a tenant over their limit, a
 * transcription rate on the floor - takes orange. No tile is coloured for being
 * merely interesting.
 */

export function CommercialTiles({ data }: { data: Commercial }) {
  // The primary currency: the one with the most recurring revenue. The others
  // are named under the tile rather than added to it.
  const currencies = data.mrr.byCurrency;
  const primary = currencies[0] ?? null;
  const others = currencies.slice(1);

  const captureUsedPct =
    data.capture.limitMinutes > 0
      ? Math.round((data.capture.usedMinutes / data.capture.limitMinutes) * 10_000)
      : null;

  const transcriptionBp = data.transcription24h.rateBp;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="MRR"
          value={primary ? money(primary.recurringMinor, primary.currency) : "—"}
          context={
            primary ? (
              <>
                {primary.recurringClients} paying client
                {primary.recurringClients === 1 ? "" : "s"}
                {others.length > 0 ? (
                  <span className="block">
                    plus{" "}
                    {others
                      .map((o) => `${money(o.recurringMinor, o.currency)} ${o.currency}`)
                      .join(", ")}
                    , not added in
                  </span>
                ) : null}
              </>
            ) : (
              "No priced subscription yet"
            )
          }
          footer={
            <span className="text-[11px] text-text-subtle">
              {primary && primary.atRiskClients > 0 ? (
                <span className="block text-danger-text">
                  {money(primary.atRiskMinor, primary.currency)} past due across{" "}
                  {primary.atRiskClients} client
                  {primary.atRiskClients === 1 ? "" : "s"}, not counted above
                </span>
              ) : null}
              {data.mrr.unpriced > 0 ? (
                <span className="block">
                  {data.mrr.unpriced} client{data.mrr.unpriced === 1 ? "" : "s"} on a plan with no
                  published price &mdash; excluded, not counted as free
                </span>
              ) : null}
              {data.mrr.trialing > 0 ? (
                <span className="block">{data.mrr.trialing} in trial</span>
              ) : null}
            </span>
          }
        />

        <StatCard
          label="Clients"
          value={data.clientCounts.active}
          context={`${data.clientCounts.total} total in this book`}
          footer={
            <span className="text-[11px] text-text-subtle">
              {data.clientCounts.suspended > 0 ? `${data.clientCounts.suspended} suspended · ` : ""}
              {data.clientCounts.churned} churned
            </span>
          }
        />

        <StatCard
          label="Net new this month"
          value={data.netNew.net >= 0 ? `+${data.netNew.net}` : `${data.netNew.net}`}
          context={`${data.netNew.newThisMonth} arrived, ${data.netNew.churnedThisMonth} left`}
          trend={trendFromBp(data.netNew.deltaBp, "last month") ?? undefined}
          footer={
            <span className="text-[11px] text-text-subtle">
              {/* Said on the tile, not in a tooltip: a reader who acts on this
                  number needs to know the churn half is an upper bound. */}
              Churn is a proxy &mdash; nothing records when a tenant churned
            </span>
          }
        />

        <StatCard
          label="Unsettled"
          value={data.unsettled.orders === 0 ? "—" : money(data.unsettled.minor, primary?.currency ?? "INR")}
          context={
            data.unsettled.orders === 0
              ? "Every order settled"
              : `${data.unsettled.orders} order${data.unsettled.orders === 1 ? "" : "s"} awaiting payment`
          }
          // Orange past zero, never red.
          state={data.unsettled.orders > 0 ? "error" : undefined}
          stateLabel="Unpaid"
          footer={
            <span className="text-[11px] text-text-subtle">
              {data.unsettled.oldestAt ? (
                <span className="block">Oldest {ageFrom(data.unsettled.oldestAt)} old</span>
              ) : null}
              {/* The correction, on the tile. The plan asked for "overdue". */}
              Unsettled, not overdue &mdash; these orders carry no due date
            </span>
          }
        />

        <StatCard
          label="Capture minutes"
          value={captureUsedPct === null ? "—" : pct(captureUsedPct, 0)}
          context={
            data.capture.clientsWithLimit === 0
              ? "No client has an hours limit"
              : `${hoursMinutes(data.capture.usedMinutes)} of ${hoursMinutes(
                  data.capture.limitMinutes,
                )} sold`
          }
          state={data.capture.overLimit > 0 ? "error" : undefined}
          stateLabel="Over"
          footer={
            <span className="text-[11px] text-text-subtle">
              {data.capture.overLimit > 0 ? (
                <span className="block text-danger-text">
                  {data.capture.overLimit} over their limit
                </span>
              ) : null}
              {data.capture.under25pct > 0 ? (
                <span className="block">
                  {data.capture.under25pct} under a quarter used &mdash; a renewal conversation,
                  not a good month
                </span>
              ) : null}
            </span>
          }
        />
      </div>

      <p className="text-[11px] text-text-subtle">{data.mrr.evidence}</p>
    </>
  );
}

/**
 * ROW 3 - the two tiles P1 and P2 argue for.
 *
 * Doc 49's words: the transcription success rate is "the number whose absence
 * cost 62 days", and one incident tile reading "provider out of credit · 2,792
 * calls · 62 days" is "the whole of P1 at a glance".
 */
export function DeliveryTiles({ data }: { data: Commercial }) {
  const bp = data.transcription24h.rateBp;
  // Below this, something is wrong with the product rather than with a tenant.
  const poor = bp !== null && bp < 9000;

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <StatCard
        label="Transcription success"
        value={bp === null ? "—" : pct(bp)}
        context={
          data.transcription24h.audioCalls === 0
            ? "No audio-bearing calls in the last 24 hours"
            : `${data.transcription24h.complete} of ${data.transcription24h.audioCalls} calls, last 24h`
        }
        state={poor ? "error" : undefined}
        stateLabel="Low"
        footer={
          <span className="text-[11px] text-text-subtle">
            {/* The denominator, stated. A rate whose denominator is invisible
                is a rate that gets argued with. */}
            Audio-bearing calls only &mdash; a missed-call log entry has no recording to
            transcribe
          </span>
        }
      />

      <Card className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <MonoLabel>Open platform incidents</MonoLabel>
          <Link href="/support" className="text-xs text-text-muted underline hover:text-text">
            Open queue &rarr;
          </Link>
        </div>

        {data.incidents.rows.length === 0 ? (
          <p className="py-4 text-sm text-text-muted">
            Nothing open.
            <span className="mt-1 block text-xs text-text-subtle">
              These are tickets the PLATFORM opened against itself &mdash; a vendor refusing us, a
              worker that stopped. A client-reported problem is not one of these.
            </span>
          </p>
        ) : (
          <>
            <p className="text-sm text-danger-text">
              {data.incidents.occurrences.toLocaleString()} affected call
              {data.incidents.occurrences === 1 ? "" : "s"} across {data.incidents.tickets} ticket
              {data.incidents.tickets === 1 ? "" : "s"}
            </p>
            <ul className="space-y-1.5">
              {data.incidents.rows.slice(0, 4).map((r) => (
                <li key={`${r.category}:${r.reason ?? ""}`} className="text-xs text-text-muted">
                  <span className="text-text">{(r.reason ?? r.category).replace(/_/g, " ")}</span>
                  {" · "}
                  {r.occurrences.toLocaleString()} call
                  {r.occurrences === 1 ? "" : "s"}
                  {r.oldestAt ? ` · ${ageFrom(r.oldestAt)} old` : ""}
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="border-t border-border-subtle pt-2 text-[11px] text-text-subtle">
          {data.incidents.evidence}
        </p>
      </Card>
    </div>
  );
}
