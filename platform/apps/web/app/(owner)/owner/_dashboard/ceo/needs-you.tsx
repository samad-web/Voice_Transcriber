import Link from "next/link";
import type { Alert } from "@/lib/ceo-dashboard";
import { Panel, PanelHead } from "./panel";

/**
 * What needs the reader, ranked by what fixing it is worth (Build docs/46).
 *
 * ── RANKED BY MONEY, AND IT SAYS SO IN THE TITLE ────────────────────────────
 *
 * The ordering is the panel's whole contribution. A console can already tell
 * somebody that three leads are uncontacted and that the recorder is dropping
 * calls; what it has never been able to tell them is which to do first. The
 * title names the sort so the order reads as a claim the panel is making,
 * rather than as the order the queries happened to run in. `rankAlerts()`
 * holds the arithmetic and the tests.
 *
 * ── SEVERITY IS A DOT AND A WORD, NEVER THE ROW'S COLOUR ────────────────────
 *
 * Two levels only, and each is a filled dot plus the `sr-only` word beside it.
 * Painting the row - a red band for critical - would collide head-on with
 * this console's colour rule: red means a customer was not picked up
 * (state.tsx), and a red row here means "worth a lot of money", which is a
 * different claim in the same ink. The dot is small, adjacent to text that
 * carries the same meaning, and the ordering already says what is urgent.
 *
 * The impact column is `tabular-nums` and right-aligned so four rows of mixed
 * units still form a column the eye can run down.
 */
export function NeedsYou({ alerts }: { alerts: readonly Alert[] }) {
  if (alerts.length === 0) {
    return (
      <Panel>
        <PanelHead title="Needs you" />
        <p className="py-2 text-sm text-text-muted">
          Nothing is flagged. Calling is steady, every lead has been picked up, and the recorder is
          keeping up.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="p-0">
      <div className="px-6 pt-6">
        <PanelHead title="Needs you" note="ranked by revenue impact" />
      </div>
      <ul className="divide-y divide-border">
        {alerts.map((a) => (
          <li
            key={a.key}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-6 py-3 sm:flex-nowrap"
          >
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                a.severity === "critical" ? "bg-danger" : "bg-orange"
              }`}
            />
            <span className="sr-only">{a.severity === "critical" ? "Critical:" : "Warning:"}</span>
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-semibold text-text">{a.headline}</span>{" "}
              <span className="text-text-muted">· {a.detail}</span>
            </p>
            <p className="shrink-0 text-right text-sm text-text-muted tabular-nums">{a.impact}</p>
            {a.action ? (
              <Link
                href={a.action.href}
                className="shrink-0 rounded-sm text-sm font-medium text-accent-text underline underline-offset-2 transition-colors duration-150 ease-out hover:text-accent"
              >
                {a.action.label} →
              </Link>
            ) : (
              // The column keeps its width with no link, so the impact figures
              // above and below it stay in one column.
              <span aria-hidden="true" className="shrink-0 text-sm text-transparent">
                —
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="h-2" />
    </Panel>
  );
}
