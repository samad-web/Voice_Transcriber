import { Card, MonoLabel } from "@aura/ui";
import { money, pct } from "./money";
import type { Commercial } from "./types";

/**
 * REVENUE CONCENTRATION (doc 49 P13c, Row 2 chart 3).
 *
 * ── WHY A NUMBER AND NOT A PIE ──────────────────────────────────────────────
 *
 * Doc 49 asks for "revenue share of the largest tenant" and gives the reason
 * out loud: "at four clients this is a number that should frighten somebody,
 * which is precisely why it belongs on the screen."
 *
 * A pie chart of four slices is the textbook wrong form for that: the question
 * is not "how is revenue divided" but "how much of it rests on one customer",
 * which is a single magnitude. So it renders as the magnitude, with a bar for
 * orientation and the tenant NAMED - because "68%" is an abstraction and
 * "68% is Sirah Digital" is a conversation about a renewal.
 *
 * ── PER CURRENCY, LIKE EVERYTHING ELSE HERE ─────────────────────────────────
 *
 * A share computed over a denominator of INR + AED is not a share of anything.
 *
 * ── THE THRESHOLDS ARE NAMED, NOT COLOURED ──────────────────────────────────
 *
 * Above 50% in one customer the panel says what that means in words. No red
 * fill: red means a missed call in this console, and nothing here is a call
 * state. The words do the work.
 */

/** Above this, one customer leaving takes the business with them. */
const ALARMING_BP = 5000;

export function Concentration({ data }: { data: Commercial["concentration"] }) {
  const rows = data.byCurrency.filter((c) => c.clients > 0);

  return (
    <Card className="space-y-4">
      <div>
        <MonoLabel>Revenue concentration</MonoLabel>
        <p className="mt-1 text-xs text-text-muted">
          How much of the recurring revenue rests on one customer.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">
          No recurring revenue to concentrate yet.
          <span className="mt-1 block text-xs text-text-subtle">
            Not &ldquo;well diversified&rdquo; &mdash; nothing is being measured.
          </span>
        </p>
      ) : (
        <div className="space-y-5">
          {rows.map((c) => {
            const alarming = c.largestBp >= ALARMING_BP;
            return (
              <div key={c.currency} className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-3xl font-bold tabular-nums text-text">
                    {pct(c.largestBp, 0)}
                  </span>
                  <span className="text-xs text-text-muted">
                    largest of {c.clients} paying client{c.clients === 1 ? "" : "s"}
                    {rows.length > 1 ? ` (${c.currency})` : ""}
                  </span>
                </div>

                <span className="relative block h-5 overflow-hidden rounded-[4px] bg-bg-subtle">
                  <span
                    className="absolute inset-y-0 left-0 rounded-[4px] bg-chart-cat-1"
                    style={{ width: `${Math.min(100, c.largestBp / 100)}%` }}
                  />
                  {/* The top three, drawn behind as a lighter extent, so the
                      two numbers are one picture rather than two bars that
                      have to be mentally added. */}
                  <span
                    className="absolute inset-y-0 rounded-r-[4px] bg-chart-cat-3"
                    style={{
                      left: `${Math.min(100, c.largestBp / 100)}%`,
                      width: `${Math.max(0, Math.min(100, (c.topThreeBp - c.largestBp) / 100))}%`,
                    }}
                  />
                </span>

                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                    <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-chart-cat-1" />
                    {c.largest ? c.largest.name : "Largest"}
                    {c.largest ? ` · ${money(c.largest.minor, c.currency)}/mo` : ""}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                    <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-chart-cat-3" />
                    Next two &middot; top three together {pct(c.topThreeBp, 0)}
                  </span>
                </div>

                {alarming ? (
                  <p className="text-xs text-danger-text">
                    {c.largest ? c.largest.name : "One client"} leaving would take{" "}
                    {pct(c.largestBp, 0)} of the recurring revenue with them.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <p className="border-t border-border-subtle pt-3 text-[11px] text-text-subtle">
        {data.evidence}
      </p>
    </Card>
  );
}
