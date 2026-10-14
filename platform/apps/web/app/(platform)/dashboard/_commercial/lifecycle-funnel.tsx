import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { pct } from "./money";
import type { Commercial } from "./types";

/**
 * THE CLIENT LIFECYCLE FUNNEL (doc 49 P13c, Row 2 chart 2).
 *
 * ── THE CHART DOC 49 WANTED THIS SCREEN FOR ─────────────────────────────────
 *
 * Its words: "a cohort that provisions and never reaches 'first transcript' is
 * a refund queue, and on today's numbers that is most of them." This is the
 * chart that would have surfaced the 62-day ASR outage COMMERCIALLY - not as a
 * pipeline alert, but as tenants who paid and got nothing.
 *
 * ── EACH STEP IS QUOTED AGAINST THE ONE ABOVE IT ────────────────────────────
 *
 * That is the difference between a funnel that names the failure and one that
 * only says things are bad. Quoted against the FIRST step, "45%" and "9%" are
 * both terrible and neither tells you where the cohort died. Against the
 * previous step, "20% of tenants that made a call ever got a transcript" points
 * at exactly one thing. Both are shown, because both questions are asked.
 *
 * ── IT STARTS AT PROVISIONED, NOT AT SIGNUP ─────────────────────────────────
 *
 * Doc 49 asks for signup first. That step counts a DIFFERENT POPULATION: an
 * operator-provisioned tenant has no `org_signups` row, so "signups" is
 * smaller than "provisioned" and the funnel would climb. A funnel that goes up
 * is not a funnel - it is two unrelated numbers in a shape that implies a rate.
 *
 * The self-serve leak is real and is not discarded: paid-but-never-provisioned
 * is shown beside the funnel as its own figure, labelled platform-wide because
 * those rows have no org and so cannot be attributed to an operator.
 *
 * ── NO RED FILL ─────────────────────────────────────────────────────────────
 *
 * A bad step is set in `danger-text` as TYPE, with words that say what is bad.
 * The console reserves red fills for the missed-call state, and nothing on this
 * panel is a call state.
 */

/** Below this share of the previous step, the drop is called out in words. */
const BAD_DROP_BP = 5000;

export function LifecycleFunnel({ data }: { data: Commercial["lifecycle"] }) {
  const steps = data.steps;
  const top = steps[0]?.count ?? 0;

  // The worst consecutive drop, named in the insight line. Computed rather
  // than asserted, so the sentence cannot go stale when the numbers move.
  const worst = steps
    .slice(1)
    .filter((s) => s.ofPreviousBp !== null)
    .sort((a, b) => (a.ofPreviousBp ?? 0) - (b.ofPreviousBp ?? 0))[0];

  return (
    <Card className="space-y-4">
      <div>
        <MonoLabel>Client lifecycle</MonoLabel>
        <p className="mt-1 text-xs text-text-muted">
          Each step as a share of the step above it. Where a cohort stops is the number that
          matters, not how far it got.
        </p>
      </div>

      {top === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">No clients in this book yet.</p>
      ) : (
        <div className="space-y-1">
          {steps.map((s, i) => {
            const bad = s.ofPreviousBp !== null && s.ofPreviousBp < BAD_DROP_BP;
            return (
              <div key={s.key}>
                {i > 0 ? (
                  <p
                    className={`py-1 pl-32 text-xs font-medium ${
                      bad ? "text-danger-text" : "text-text-subtle"
                    }`}
                  >
                    <span aria-hidden="true">&darr; </span>
                    {pct(s.ofPreviousBp, 0)} of the step above
                    {bad ? " — this is where the cohort stops" : ""}
                  </p>
                ) : null}
                <div className="group relative flex items-center gap-3">
                  <span className="w-32 shrink-0 text-xs text-text-muted">{s.label}</span>
                  <span className="relative h-5 flex-1 overflow-hidden rounded-[4px] bg-bg-subtle">
                    <span
                      className="absolute inset-y-0 left-0 rounded-[4px] bg-chart-cat-1"
                      style={{ width: `${top > 0 ? (s.count / top) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="w-24 shrink-0 text-right text-sm font-bold tabular-nums text-text">
                    {s.count}
                    <span className="ml-1 text-[10px] font-normal text-text-subtle">
                      {pct(s.ofFirstBp, 0)}
                    </span>
                  </span>
                </div>
                <p className="pl-32 text-[10px] text-text-subtle">{s.evidence}</p>
              </div>
            );
          })}
        </div>
      )}

      {worst && worst.ofPreviousBp !== null && worst.ofPreviousBp < BAD_DROP_BP ? (
        <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-xs text-text-muted">
          The steepest drop is into <strong className="text-text">{worst.label}</strong>, at{" "}
          {pct(worst.ofPreviousBp, 0)} of the step before it.
          {worst.key === "first_transcript" ? (
            <>
              {" "}
              A tenant that records calls and never gets a transcript has paid for a product they
              have not received. Check the{" "}
              <Link href="/support" className="underline hover:text-text">
                escalation queue
              </Link>{" "}
              for platform incidents before reading this as a usage problem.
            </>
          ) : null}
        </p>
      ) : null}

      {data.paidNeverProvisioned > 0 ? (
        <p className="text-xs text-danger-text">
          {data.paidNeverProvisioned} self-serve signup
          {data.paidNeverProvisioned === 1 ? " has" : "s have"} been paid for and never provisioned.
          <span className="text-text-subtle">
            {" "}
            Counted platform-wide, not per operator: a signup with no workspace has no org to
            attribute.
          </span>
        </p>
      ) : null}

      <p className="border-t border-border-subtle pt-3 text-[11px] text-text-subtle">
        {data.evidence}
      </p>
    </Card>
  );
}
