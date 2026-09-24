import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  CATEGORY_LABELS,
  NEVER_SENDS,
  canSeeApp,
  integrationById,
  primaryAction,
  stateChip,
  type IntegrationDetail,
  type IntegrationSpec,
} from "@aura/shared";
import { Card, MonoLabel, StatusChip, buttonClasses, buttonStyle } from "@aura/ui";
import { BreadcrumbLeaf } from "@/components/breadcrumbs";
import { LoadFailure } from "@/components/load-failure";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { OWNER_NAV_ITEMS, navItemFor } from "@/lib/nav";
import { getOwner, ownerGet, ownerTry, requireFeature } from "@/lib/owner-context";
import { supportHref, supportLabel } from "@/lib/support-contact";
import type { OAuthAppsView } from "../../connections/actions";
import { OAuthAppsPanel } from "../../connections/oauth-apps-panel";
import { MyWhatsApp } from "../../inbox/my-whatsapp";
import type { PaymentSettings } from "../../invoices/actions";
import { PaymentSettingsCard } from "../../invoices/payment-settings";
import { AFTER_CONNECT, DISCONNECT_COPY } from "../app-copy";
import { actionHref, connectHref } from "../app-links";
import { AppLogo } from "../app-logo";
import { ConnectionList } from "../connection-list";

type Params = Promise<{ appId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { appId } = await params;
  return { title: integrationById(appId)?.label ?? "Integration" };
}

/**
 * One app (doc 28 §10): what it does, what it can touch, what you need, its
 * connections and their history, and the one thing to do next.
 *
 * ── GATES, IN ORDER ─────────────────────────────────────────────────────────
 *
 * An unknown id, or one held back from the store, is a 404. So is an app
 * whose feature this org switched off - off means off (requireFeature), and
 * the API answers 404 for it too. A persona that cannot see the app is sent
 * back to the store rather than shown a page of things it may not do.
 *
 * ── HOSTED, NOT REWRITTEN ───────────────────────────────────────────────────
 *
 * The settings a person changes after connecting already have screens: the
 * organisation's own sign-in app (0120), the payment keys, the personal
 * WhatsApp link. This page hosts those components as they are, so the store
 * and the page that used to own each one run the same code.
 */
export default async function IntegrationAppPage({ params }: { params: Params }) {
  const { appId } = await params;
  const spec = integrationById(appId);
  if (!spec || spec.unlisted) notFound();

  await requireFeature("/owner/integrations");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");
  const role = owner.membership.ownerRole;
  if (!canSeeApp(spec, role)) redirect("/owner/integrations");

  // The organisation's own sign-in app (0120) is the owner's to add, on any
  // app that signs in through one - Sheets reads through the Google app too.
  const oauthHost = Boolean(spec.oauthProvider) && role === "owner";
  const [detail, oauthApps, payments] = await Promise.all([
    ownerTry<IntegrationDetail>(`/v1/owner/integrations/${spec.id}`),
    oauthHost ? ownerGet<OAuthAppsView>("/v1/connections/oauth-apps") : Promise.resolve(null),
    spec.id === "razorpay" && role === "owner"
      ? ownerGet<{ settings: PaymentSettings }>("/v1/owner/payment-settings")
      : Promise.resolve(null),
  ]);
  if (!detail.ok && detail.kind === "notfound") notFound();

  const support = supportHref();

  return (
    <>
      <BreadcrumbLeaf label={spec.label} />
      <PageHeader title={spec.label} context="Connected apps" />

      {detail.ok ? (
        <AppHero spec={spec} detail={detail.data} role={role} />
      ) : (
        <LoadFailure what={`${spec.label}'s status`} failure={detail} />
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {detail.ok ? (
            <ConnectionsSection spec={spec} detail={detail.data} />
          ) : null}

          {spec.id === "razorpay" && payments ? (
            <Section title="Payment settings">
              <PaymentSettingsCard initial={payments.settings} />
            </Section>
          ) : null}

          {oauthApps ? (
            <section id="sign-in-app" className="scroll-mt-24">
              <OAuthAppsPanel data={oauthApps} />
            </section>
          ) : null}

          {detail.ok ? <ActivitySection detail={detail.data} /> : null}
        </div>

        <aside className="min-w-0 space-y-4">
          <Card>
            <MonoLabel>About</MonoLabel>
            <p className="mt-2 text-sm leading-relaxed text-text">{spec.about}</p>
            {AFTER_CONNECT[spec.id] ? (
              <p className="mt-2 text-sm leading-relaxed text-text-muted">{AFTER_CONNECT[spec.id]}</p>
            ) : null}
            {spec.notice ? <p className="mt-2 text-sm font-medium text-text">{spec.notice}</p> : null}
            <OpsLink spec={spec} />
          </Card>

          <Card>
            <MonoLabel>What Aura can access</MonoLabel>
            <AccessList spec={spec} />
          </Card>

          <Card>
            <MonoLabel>What you&apos;ll need</MonoLabel>
            <NeedsList spec={spec} />
          </Card>

          {detail.ok ? <GetIt spec={spec} detail={detail.data} support={support} role={role} /> : null}

          {DISCONNECT_COPY[spec.id] ? (
            <section className="rounded-xl border border-border px-5 py-4">
              <MonoLabel>{DISCONNECT_COPY[spec.id]!.verb}</MonoLabel>
              <dl className="mt-2 space-y-1.5 text-sm">
                <div>
                  <dt className="inline text-text-muted">Stops: </dt>
                  <dd className="inline text-text">{DISCONNECT_COPY[spec.id]!.stops}</dd>
                </div>
                <div>
                  <dt className="inline text-text-muted">Stays: </dt>
                  <dd className="inline text-text">{DISCONNECT_COPY[spec.id]!.stays}</dd>
                </div>
              </dl>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}

/* ── The header row ──────────────────────────────────────────────────────── */

function AppHero({ spec, detail, role }: { spec: IntegrationSpec; detail: IntegrationDetail; role: Parameters<typeof primaryAction>[0]["role"] }) {
  const { status } = detail;
  const chip = stateChip(status.state, status.count, status.total);
  const action = primaryAction({ spec, state: status.state, canManage: status.canManage, role });
  const lastActivity = detail.connections
    .map((c) => c.lastActivityAt)
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  // "Add another": a multiple app that already has one, for someone who may.
  const addAnother =
    spec.multiple && status.canManage && status.total > 0 && status.state !== "attention";

  return (
    <div className="-mt-2 flex flex-wrap items-start gap-x-4 gap-y-3">
      <AppLogo spec={spec} size="lg" />
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm text-text-muted">
          by <span className="text-text">{spec.vendor}</span> · {CATEGORY_LABELS[spec.category]}
          {spec.scope === "person" ? " · Each person connects their own" : ""}
        </p>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-text">{spec.blurb}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
          {chip ? <StatusChip tone={chip.tone}>{chip.text}</StatusChip> : <span>Not connected</span>}
          {lastActivity ? (
            <span>
              Last activity <LocalTime iso={lastActivity} />
            </span>
          ) : null}
          {status.teamCount !== null && status.teamCount > 0 ? (
            <span>
              {status.teamCount} {status.teamCount === 1 ? "person has" : "people have"} linked their own
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {addAnother ? (
          <Link href={connectHref(spec.id)} className={buttonClasses({ variant: "secondary" })}>
            Add another
          </Link>
        ) : null}
        {action && action.kind !== "open" ? (
          <Link
            href={actionHref(spec.id, action.kind)}
            className={buttonClasses({ variant: action.emphasis === "primary" ? "primary" : "secondary" })}
            style={action.emphasis === "primary" ? buttonStyle("primary") : undefined}
          >
            {action.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/* ── Sections ────────────────────────────────────────────────────────────── */

function Section({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} aria-label={title} className="scroll-mt-24 space-y-2">
      <MonoLabel>{title}</MonoLabel>
      {children}
    </section>
  );
}

function ConnectionsSection({ spec, detail }: { spec: IntegrationSpec; detail: IntegrationDetail }) {
  // Personal WhatsApp's truth is the relay's, live - the panel the Inbox uses
  // asks it; a row from our own table could only say what we last stored.
  if (spec.id === "whatsapp_personal") {
    return (
      <Section title="Your number" id="connections">
        <Card>
          <MyWhatsApp />
        </Card>
      </Section>
    );
  }

  const { connections, status } = detail;
  const gated = status.state === "not_entitled" || status.state === "unavailable";
  if (gated && connections.length === 0) return null;

  return (
    <Section title={`Connections (${connections.length})`} id="connections">
      {connections.length > 0 ? (
        <ConnectionList appId={spec.id} connections={connections} canManage={status.canManage} />
      ) : (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-text-muted">
          {spec.scope === "person"
            ? "You have not connected one yet."
            : spec.connect === "provider_managed"
              ? "Your provider has not set this up for your workspace."
              : "Nothing connected yet."}
        </p>
      )}
    </Section>
  );
}

function ActivitySection({ detail }: { detail: IntegrationDetail }) {
  if (detail.activity.length === 0) return null;
  return (
    <Section title="Activity">
      <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {detail.activity.map((item, i) => (
          <li key={`${item.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
            <span className="w-36 shrink-0 text-xs text-text-muted">
              <LocalTime iso={item.at} />
            </span>
            <span className={`min-w-0 flex-1 ${item.tone === "attention" ? "text-orange-text" : "text-text"}`}>
              {/* "Priya connected …" reads as a sentence; with nobody to name
                  (an operator script, the platform key) it starts the line. */}
              {item.actor ? (
                <>
                  <span className="font-medium">{item.actor}</span> {item.text}
                </>
              ) : (
                item.text.charAt(0).toUpperCase() + item.text.slice(1)
              )}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function AccessList({ spec }: { spec: IntegrationSpec }) {
  return (
    <dl className="mt-2 space-y-2.5 text-sm">
      <div>
        <dt className="text-xs text-text-muted">Reads</dt>
        {spec.access.reads.map((r) => (
          <dd key={r} className="mt-0.5 text-text">
            {r}
          </dd>
        ))}
      </div>
      <div>
        <dt className="text-xs text-text-muted">Writes</dt>
        {spec.access.writes.map((w) => (
          <dd key={w} className="mt-0.5 text-text">
            {w}
          </dd>
        ))}
      </div>
      <div>
        <dt className="text-xs text-text-muted">Never</dt>
        <dd className="mt-0.5 text-text">{NEVER_SENDS}</dd>
      </div>
    </dl>
  );
}

function NeedsList({ spec }: { spec: IntegrationSpec }) {
  const deps = (spec.dependsOn ?? []).flatMap((id) => {
    const dep = integrationById(id);
    return dep ? [dep] : [];
  });
  return (
    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-text marker:text-text-subtle">
      {spec.needs.map((n) => (
        <li key={n}>{n}</li>
      ))}
      {deps.map((dep) => (
        <li key={dep.id}>
          <Link href={`/owner/integrations/${dep.id}`} className="underline underline-offset-2 hover:text-text">
            {dep.label}
          </Link>{" "}
          connected first
        </li>
      ))}
    </ul>
  );
}

function OpsLink({ spec }: { spec: IntegrationSpec }) {
  if (!spec.opsHref) return null;
  const page = navItemFor(spec.opsHref, OWNER_NAV_ITEMS);
  return (
    <p className="mt-3 text-sm">
      <Link href={spec.opsHref} className="font-medium text-text underline-offset-2 hover:underline">
        Day to day: {page?.title ?? "Open"} →
      </Link>
    </p>
  );
}

/**
 * The "how do I get it" card, for every answer that is not a Connect button:
 * not on the plan, not on this deployment, set up by the provider, or the
 * account owner's to connect.
 */
function GetIt({
  spec,
  detail,
  support,
  role,
}: {
  spec: IntegrationSpec;
  detail: IntegrationDetail;
  support: string | null;
  role: Parameters<typeof primaryAction>[0]["role"];
}) {
  const action = primaryAction({ spec, state: detail.status.state, canManage: detail.status.canManage, role });
  if (!action || !["ask_provider", "ask_owner"].includes(action.kind)) return null;

  const why =
    detail.status.state === "not_entitled"
      ? `${spec.label} is not on your plan.`
      : detail.status.state === "unavailable"
        ? spec.oauthProvider
          ? `${spec.label} needs your organisation's own sign-in app, which the account owner adds here.`
          : "Your provider has not set this up on this deployment yet."
        : spec.connect === "provider_managed"
          ? "Your provider sets this up and keeps it running."
          : `Only ${spec.manageRoles.length === 1 ? "the account owner" : "an owner or manager"} can connect ${spec.label}.`;

  return (
    <section id="get-it" className="scroll-mt-24 rounded-xl border border-border px-5 py-4">
      <MonoLabel>How to get it</MonoLabel>
      <p className="mt-2 text-sm text-text">{why}</p>
      {action.kind === "ask_provider" ? (
        <p className="mt-2 text-sm text-text-muted">
          {support ? (
            <>
              Ask your provider:{" "}
              <a href={support} className="text-text underline underline-offset-2">
                {supportLabel(support)}
              </a>
            </>
          ) : (
            "Ask the company that set up Aura for you."
          )}
        </p>
      ) : (
        <p className="mt-2 text-sm text-text-muted">Ask your account owner to connect it.</p>
      )}
    </section>
  );
}
