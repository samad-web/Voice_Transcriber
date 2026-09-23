import Link from "next/link";
import { integrationById, type IntegrationStatus } from "@aura/shared";
import { StateRule } from "@aura/ui";
import { actionHref } from "./app-links";

const SHOWN = 3;

/**
 * The failing apps, above the grid, in the provider's own words (doc 28 §9).
 *
 * One line each, at most three, then "+N more" into the Needs attention view.
 * Orange rule, grey text: attention is orange in this console (red means a
 * missed call), and the rule is enough to find it without turning a sentence
 * into an alarm.
 */
export function AttentionStrip({ statuses }: { statuses: IntegrationStatus[] }) {
  const failing = statuses.filter((s) => s.state === "attention");
  if (failing.length === 0) return null;
  const rest = failing.length - SHOWN;

  return (
    <section aria-label="Apps that need attention" className="space-y-1.5">
      {failing.slice(0, SHOWN).map((s) => {
        const spec = integrationById(s.id);
        if (!spec) return null;
        return (
          <div
            key={s.id}
            className="relative flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface py-2 pr-2 pl-4 text-sm"
          >
            <StateRule state="error" />
            <p className="min-w-0 flex-1 text-text-muted">
              <span className="font-medium text-text">{spec.label} needs attention</span>
              {s.attentionReason ? <> - &ldquo;{s.attentionReason}&rdquo;</> : null}
            </p>
            <Link
              href={actionHref(s.id, s.canManage ? "fix" : "open")}
              className="shrink-0 rounded-sm px-2 py-1 text-xs font-medium text-text underline-offset-2 hover:underline"
            >
              {s.canManage ? "Fix" : "Open"}
            </Link>
          </div>
        );
      })}
      {rest > 0 ? (
        <Link
          href="/owner/integrations?view=attention"
          className="inline-block text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
        >
          +{rest} more
        </Link>
      ) : null}
    </section>
  );
}
