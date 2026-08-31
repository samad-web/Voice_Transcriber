import type { ReactNode } from "react";
import { Card } from "./card";
import { MonoLabel } from "./mono-label";

export function StatCard({
  label,
  value,
  icon,
  footer,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="flex flex-col justify-between">
      <div className="flex items-start justify-between gap-3">
        {/* min-w-0 + break-words: long values (region codes, 7-digit counts)
            wrap inside a narrow single-column card instead of overflowing it. */}
        <div className="min-w-0">
          <MonoLabel>{label}</MonoLabel>
          {/* tabular-nums so a dashboard of counters does not reflow by a pixel
              on every poll. font-semibold is the heaviest weight in the system -
              the old font-black is gone with the display face. */}
          <p className="mt-2 text-3xl font-semibold break-words text-text tabular-nums">{value}</p>
        </div>
        {icon ? (
          // aria-hidden: the icon restates the label, and an unlabelled <svg>
          // announced next to it is noise. Callers pass lucide icons, which
          // otherwise expose themselves as generic graphics.
          <div
            aria-hidden="true"
            className="shrink-0 rounded-md bg-accent-subtle p-2 text-accent-text"
          >
            {icon}
          </div>
        ) : null}
      </div>
      {footer ? (
        <div className="mt-4 flex items-center gap-1.5 border-t border-border pt-3 text-xs text-text-muted tabular-nums">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}
