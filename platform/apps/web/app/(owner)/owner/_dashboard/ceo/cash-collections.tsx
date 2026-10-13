import { Panel, PanelHead } from "./panel";

/**
 * Cash and collections (Build docs/46).
 *
 * ── A PANEL THAT IS USUALLY EMPTY, ON PURPOSE ───────────────────────────────
 *
 * Collections live in the finance module, behind a deal template the tenant
 * has to create. Most workspaces on this dashboard have not, so most of the
 * time every figure here is unknown.
 *
 * The temptation is to hide the panel until it has data. That is wrong here,
 * and the reason is the funnel three cards up: it ends at "Revenue", and a
 * dashboard that stops at revenue teaches an owner that revenue is the end of
 * the process. The gap between money won and money banked is the single
 * largest blind spot this console has, and an empty panel that NAMES the six
 * figures it would show - and says, in its own header, exactly which one
 * action turns them on - is a better answer than silence.
 *
 * So the tiles render as dashed outlines with em-dashes: visibly not zero,
 * visibly not broken, visibly waiting for something. An em-dash is this
 * console's "we cannot answer that" everywhere else; a zero here would be a
 * claim that nothing was collected.
 */

export interface CashFigure {
  key: string;
  label: string;
  /** Null renders the dashed empty tile. */
  value: string | null;
}

export function CashCollections({
  figures,
  note,
  setup,
}: {
  figures: readonly CashFigure[];
  /** The one line under the tiles - what IS known, and what is due. */
  note: string;
  /** The action that turns the panel on. Null once it is on. */
  setup: { label: string; href: string } | null;
}) {
  return (
    <Panel>
      <PanelHead
        title="Cash & collections"
        link={setup ? { label: setup.label, href: setup.href } : null}
      />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {figures.map((f) => (
          <div
            key={f.key}
            className={`rounded-lg px-3 py-2.5 ${
              f.value === null ? "border border-dashed border-border-strong" : "border border-border bg-bg-subtle"
            }`}
          >
            <dt className="text-xs text-text-muted">{f.label}</dt>
            <dd
              className={`mt-1 text-base tabular-nums ${
                f.value === null ? "text-text-subtle" : "font-semibold text-text"
              }`}
            >
              {f.value ?? "—"}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-text-muted">{note}</p>
    </Panel>
  );
}
