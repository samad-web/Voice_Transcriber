import type { ReactNode } from "react";
import { Card, StatusChip } from "@aura/ui";

/**
 * The frame every switch under Settings > Modules shares.
 *
 * The four module cards sit two to a row. Each one used to lay itself out -
 * button straight after its own copy, grid set to `items-start` - so two cards
 * in a row ended at different heights, the buttons landed wherever the text ran
 * out, and a short card left a hole the height of its neighbour's extra panel.
 * Now the grid stretches a row to its tallest card and this frame pins the
 * action to a footer: headers line up across a row, and so do the buttons,
 * whatever each body holds.
 *
 * The head strip is the same one TablePanel draws on this page (PANEL_HEAD in
 * page.tsx), so a module card reads as the same kind of surface as the panels
 * on the Overview and Devices tabs rather than a one-off.
 */
export function ModuleCard({
  icon,
  title,
  enabled,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  enabled: boolean;
  /** The footer: the switch itself, or whatever replaces it mid-decision. */
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card elevated className="flex flex-col overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="shrink-0 text-text-muted">
            {icon}
          </span>
          <h4 className="text-sm font-medium text-text">{title}</h4>
        </div>
        <StatusChip tone={enabled ? "solid" : "muted"}>{enabled ? "On" : "Off"}</StatusChip>
      </div>

      {/* flex-1 is what keeps the footer at the bottom of a stretched card. */}
      <div className="flex-1 space-y-3 px-5 py-4">{children}</div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
        {action}
      </div>
    </Card>
  );
}

/**
 * A nested detail panel inside a module card (who can read transcripts, where
 * the client signs in, the backlog chooser).
 *
 * The decorative hairline, not --color-border-strong: that token exists to give
 * a *control's* edge 3:1 (control-styles.ts), and on a panel that nobody types
 * into it drew a bright grey box that competed with the card's own border.
 *
 * No spacing utility in here: call sites add their own `space-y-*`, and two of
 * those on one element resolve by stylesheet order, not by which came last.
 */
export const MODULE_INSET = "rounded-lg border border-border bg-bg-subtle p-3.5";
