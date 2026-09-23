import Link from "next/link";
import {
  CATEGORY_LABELS,
  primaryAction,
  stateChip,
  type IntegrationSpec,
  type IntegrationStatus,
  type OwnerRole,
} from "@aura/shared";
import { StatusChip, buttonClasses } from "@aura/ui";
import { actionHref, appHref } from "./app-links";
import { AppLogo } from "./app-logo";

/**
 * One app in the store (doc 28 §9): logo, name, maker, one line of what it
 * does, one state chip and one button.
 *
 * ── A DIV, NOT A LINK ───────────────────────────────────────────────────────
 *
 * The whole tile is clickable, but it cannot BE a link: it contains a button,
 * and a link inside a link is invalid HTML that screen readers announce twice.
 * So the app's NAME is the link, stretched over the tile with `after:inset-0`,
 * and the action sits above that layer (`relative z-10`).
 *
 * ── CALM ────────────────────────────────────────────────────────────────────
 *
 * No error text on a tile - the failing app's own words are in the attention
 * strip above the grid and on its page. A grid of tiles each shouting is a
 * grid nobody reads. The action is always the outlined button; the filled one
 * is saved for the app page, where there is exactly one thing to do.
 */
export function AppTile({
  spec,
  status,
  role,
}: {
  spec: IntegrationSpec;
  status: IntegrationStatus;
  role: OwnerRole;
}) {
  const chip = stateChip(status.state, status.count, status.total);
  const action = primaryAction({ spec, state: status.state, canManage: status.canManage, role });
  const scopeNote = spec.scope === "person" ? "Just you" : CATEGORY_LABELS[spec.category];

  return (
    <div className="relative flex flex-col rounded-lg border border-border bg-surface p-4 transition-colors duration-150 ease-out hover:border-border-strong">
      <div className="flex items-start gap-3">
        <AppLogo spec={spec} />
        <div className="min-w-0 pt-0.5">
          <Link
            href={appHref(spec.id)}
            className="block truncate text-sm font-medium text-text after:absolute after:inset-0 after:rounded-lg after:content-['']"
          >
            {spec.label}
          </Link>
          <p className="mt-0.5 truncate text-xs text-text-muted">
            {spec.vendor} · {scopeNote}
          </p>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-text-muted">{spec.blurb}</p>
      {spec.notice ? <p className="mt-1.5 text-xs font-medium text-text">{spec.notice}</p> : null}

      <div className="mt-auto flex min-h-10 items-center justify-between gap-2 pt-4">
        {chip ? <StatusChip tone={chip.tone}>{chip.text}</StatusChip> : <span />}
        {action ? (
          <Link
            href={actionHref(spec.id, action.kind)}
            className={buttonClasses({ variant: "secondary", size: "sm", className: "relative z-10" })}
          >
            {action.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
