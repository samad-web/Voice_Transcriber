import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { LocalTime } from "@/components/local-time";
import { publicApiOrigin } from "@/lib/public-origin";
import { Quickstart } from "./quickstart";

export const metadata: Metadata = { title: "API platform" };

interface Catalog {
  kpis: {
    key: string;
    label: string;
    status: "ready" | "partial" | "missing";
    dataNeeded: string;
  }[];
}

interface Overview {
  freshness: {
    lastEventAt: string | null;
    state: "never" | "fresh" | "stale";
    perResource: { resource: string; lastAt: string | null; inLastDay: number }[];
    handsetLastAt: string | null;
  };
}

interface Unmapped {
  unmapped: {
    id: string;
    kind: string;
    external_ref: string;
    occurrences: string;
    last_seen_at: string;
  }[];
}

interface Keys {
  keys: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    env?: string;
    last_used_at: string | null;
    expires_at: string | null;
  }[];
}

/**
 * Settings → API platform: the Integration Center (§8.1 and §8.8, M6).
 *
 * ── THE PAGE IS ORDERED BY WHAT A NEW INTEGRATOR NEEDS NEXT ─────────────────
 *
 * §8.1 asks for a first-run checklist and §6.2's acceptance criterion is
 * "signup to a visible KPI in under 15 minutes". So the order is the order of
 * the work: make a key, send a telecaller, send a call, choose KPIs, see the
 * dashboard. The checklist's state is computed from what has actually arrived
 * rather than from a stored "step 3 complete" flag - a flag would go stale the
 * moment somebody revoked their key or deleted their test data.
 *
 * ── DATA COMPLETENESS PER KPI, NOT PER TABLE ────────────────────────────────
 *
 * §8.8 asks for "data completeness per KPI". Per KPI rather than per column,
 * because an integrator does not care that 40% of rows lack `connected` - they
 * care that connect rate is therefore unusable. The catalogue's own
 * "Data needed" line is what turns the second into the first.
 */
export default async function ApiPlatformPage() {
  await requireFeature("/owner/api-platform");
  await requireOwnerRoles(["owner"]);

  const [keys, catalog, overview, unmapped] = await Promise.all([
    ownerTry<Keys>("/v1/apikeys"),
    ownerTry<Catalog>("/v1/insights/kpi/catalog"),
    ownerTry<Overview>(`/v1/insights/overview?from=${thirtyDaysAgo()}&to=${todayIso()}`),
    ownerTry<Unmapped>("/v1/insights/unmapped"),
  ]);

  if (!keys.ok) {
    return (
      <>
        <PageHeader title="API platform" context="Settings" />
        <LoadFailure failure={keys} what="your API keys" />
      </>
    );
  }

  const liveKeys = keys.data.keys.filter((k) => (k.env ?? "live") === "live");
  const testKeys = keys.data.keys.filter((k) => k.env === "test");
  const freshness = overview.ok ? overview.data.freshness : null;
  const hasEvents = Boolean(freshness && freshness.state !== "never");
  const kpis = catalog.ok ? catalog.data.kpis : [];
  const chosen = kpis.filter((k) => k.status !== "missing").length > 0;
  const open = unmapped.ok ? unmapped.data.unmapped : [];

  return (
    <>
      <PageHeader
        title="API platform"
        context="Settings"
        actions={
          <Link
            href="/owner/api-platform/events"
            className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
          >
            Event inspector
          </Link>
        }
      />
      <p className="-mt-2 text-sm text-text-muted">
        Send us your call, conversion and payment data, and see it become performance figures. Every
        number on the Performance screens comes from what arrives here.
      </p>

      <Quickstart
        baseUrl={publicApiOrigin()}
        hasKey={keys.data.keys.length > 0}
        hasEvents={hasEvents}
        hasKpis={chosen}
        keys={keys.data.keys.map((k) => ({
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          env: k.env ?? "live",
          scopes: k.scopes,
        }))}
      />

      {/* §7's unmapped queue, high on the page because it is the one thing on
          it that silently loses data if ignored. */}
      {open.length > 0 ? (
        <Card>
          <MonoLabel>Data waiting on someone we do not know</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            These references arrived on events we could not attribute, so nothing was counted for
            them. Nothing was lost — create or map each one and replay.
          </p>
          <ul className="mt-3 divide-y divide-border text-sm">
            {open.map((ref) => (
              <li key={ref.id} className="flex flex-wrap items-center gap-2 py-2">
                <code className="rounded bg-surface-hover px-1.5 py-0.5 text-xs">
                  {ref.external_ref}
                </code>
                <span className="text-text-muted">
                  {ref.kind} · seen {Number(ref.occurrences).toLocaleString("en-IN")} times
                </span>
                <span className="ml-auto text-xs text-text-muted">
                  <LocalTime iso={ref.last_seen_at} />
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm">
            <Link
              href="/owner/api-platform/events?status=rejected"
              className="text-accent-text underline-offset-2 hover:underline"
            >
              Resolve them in the event inspector
            </Link>
          </p>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <MonoLabel>What has arrived</MonoLabel>
          {!freshness || freshness.perResource.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">
              Nothing yet. The quickstart above sends a test event in one command.
            </p>
          ) : (
            <dl className="mt-2 space-y-1.5 text-sm">
              {freshness.perResource.map((r) => (
                <div key={r.resource} className="flex items-baseline justify-between gap-3">
                  <dt className="text-text-muted">{r.resource}</dt>
                  <dd className="text-right">
                    <span className="tabular-nums text-text">
                      {r.inLastDay.toLocaleString("en-IN")}
                    </span>
                    <span className="ml-1 text-xs text-text-muted">in 24h</span>
                    {r.lastAt ? (
                      <span className="ml-2 text-xs text-text-muted">
                        last <LocalTime iso={r.lastAt} />
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
              {freshness.handsetLastAt ? (
                <div className="flex items-baseline justify-between gap-3 border-t border-border pt-1.5">
                  <dt className="text-text-muted">handset calls</dt>
                  <dd className="text-xs text-text-muted">
                    last <LocalTime iso={freshness.handsetLastAt} />
                  </dd>
                </div>
              ) : null}
            </dl>
          )}
          {freshness?.handsetLastAt ? null : (
            <p className="mt-3 border-t border-border pt-2 text-xs text-text-muted">
              You can also pair the Aura app on your telecallers&rsquo; phones and have those calls
              counted alongside the API&rsquo;s. They arrive as a duration, a direction and an
              outcome — no recording and no transcript reach this plan.{" "}
              <Link href="/owner/devices" className="underline underline-offset-2">
                Pair a phone
              </Link>
            </p>
          )}
        </Card>

        <Card>
          <MonoLabel>Which KPIs your data can answer</MonoLabel>
          {kpis.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">Could not read the catalogue.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {kpis.map((kpi) => (
                <li key={kpi.key}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-text">{kpi.label}</span>
                    {kpi.status === "ready" ? (
                      <StatusChip tone="muted">Ready</StatusChip>
                    ) : kpi.status === "partial" ? (
                      <StatusChip tone="outline">Partial</StatusChip>
                    ) : (
                      <StatusChip tone="outline">No data</StatusChip>
                    )}
                  </div>
                  {kpi.status !== "ready" ? (
                    <p className="text-xs text-text-muted">{kpi.dataNeeded}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <MonoLabel>Keys</MonoLabel>
        {keys.data.keys.length === 0 ? (
          <EmptyState
            title="No keys yet"
            description="A key is how your system authenticates. It is shown once, we store only its hash, and it can be revoked at any time."
            action={
              <Link
                href="/owner/integrations"
                className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
              >
                Create a key
              </Link>
            }
          />
        ) : (
          <>
            <KeyList title="Live" rows={liveKeys} />
            <KeyList
              title="Test"
              rows={testKeys}
              note="A test key writes to the same endpoints and is never counted towards a KPI. Reset its data whenever you like."
            />
            <p className="mt-3 text-sm">
              <Link
                href="/owner/integrations"
                className="text-accent-text underline-offset-2 hover:underline"
              >
                Create, scope or revoke a key
              </Link>
            </p>
          </>
        )}
      </Card>
    </>
  );
}

function KeyList({
  title,
  rows,
  note,
}: {
  title: string;
  rows: Keys["keys"];
  note?: string;
}) {
  if (rows.length === 0 && !note) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-text-muted">None.</p>
      ) : (
        <ul className="mt-1 divide-y divide-border text-sm">
          {rows.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="text-text">{key.name}</span>
              <code className="rounded bg-surface-hover px-1.5 py-0.5 text-xs">{key.prefix}…</code>
              <span className="text-xs text-text-muted">{key.scopes.length} scopes</span>
              <span className="ml-auto text-xs text-text-muted">
                {key.last_used_at ? (
                  <>
                    last used <LocalTime iso={key.last_used_at} />
                  </>
                ) : (
                  "never used"
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {note ? <p className="mt-1 text-xs text-text-muted">{note}</p> : null}
    </div>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function thirtyDaysAgo(): string {
  return new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
}
