import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  canSeeApp,
  integrationById,
  type IntegrationDetail,
  type IntegrationSpec,
  type OwnerRole,
} from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet, ownerTry, requireFeature } from "@/lib/owner-context";
import { publicApiOrigin } from "@/lib/public-origin";
import type { OAuthAppsView, ProviderView } from "../../../connections/actions";
import type { PaymentSettings } from "../../../invoices/actions";
import type { CatalogueChannel, LeadSourceRow } from "../../../lead-sources/page";
import { embeddedSignupConfigAction } from "../../../messaging-setup/actions";
import { appHref } from "../../app-links";
import { ConnectFlow } from "../../_connect/connect-flow";
import { connectPlan, type ConnectableApp } from "../../_connect/steps";
import type { ConnectData } from "../../_connect/types";

type Params = Promise<{ appId: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { appId } = await params;
  const spec = integrationById(appId);
  return { title: spec ? `Connect ${spec.label}` : "Connect" };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * The connect route (doc 28 §11.1): a real page, so a refresh keeps the step,
 * a door can deep-link into it, and an OAuth return has somewhere to land.
 *
 * ── WHO GETS IN ─────────────────────────────────────────────────────────────
 *
 * Checked here, on the server, before any step renders - and again by every
 * API route a step calls:
 *   - an app that is switched off is a 404, like its app page;
 *   - a persona that cannot see it goes back to the store;
 *   - not on the plan, not available, or not yours to manage → the app page,
 *     at the card that says who can get it. The one exception is the owner of
 *     an org with no Google/Microsoft sign-in app: the sign-in step adds it
 *     inline, because that owner is exactly who can;
 *   - a single-connection app that is already connected → its app page,
 *     unless a step is being resumed (an OAuth return, a pairing mid-way).
 */
export default async function ConnectAppPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { appId } = await params;
  const search = await searchParams;
  const spec = integrationById(appId);
  if (!spec || spec.unlisted) notFound();
  // Provider-managed tiles have no flow; their page says who sets them up.
  if (!connectPlan(appId)) redirect(appHref(appId));

  await requireFeature("/owner/integrations");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");
  const role = owner.membership.ownerRole;
  if (!canSeeApp(spec, role)) redirect("/owner/integrations");

  const detail = await ownerTry<IntegrationDetail>(`/v1/owner/integrations/${spec.id}`);
  if (!detail.ok) {
    if (detail.kind === "notfound") notFound();
    return (
      <>
        <PageHeader title={`Connect ${spec.label}`} context="Connected apps" />
        <LoadFailure what={`${spec.label}'s status`} failure={detail} />
      </>
    );
  }

  const { status, connections } = detail.data;
  const signInAppMissing = status.state === "unavailable" && spec.connect === "oauth" && role === "owner";
  if (!status.canManage) redirect(`${appHref(spec.id)}#get-it`);
  if (status.state === "not_entitled") redirect(`${appHref(spec.id)}#get-it`);
  if (status.state === "unavailable" && !signInAppMissing) {
    redirect(`${appHref(spec.id)}#${spec.oauthProvider && role === "owner" ? "sign-in-app" : "get-it"}`);
  }
  const step = first(search.step);
  const resuming = Boolean(first(search.pending) || first(search.connected) || (step && step !== "review"));
  if (!spec.multiple && status.state === "connected" && !resuming) redirect(appHref(spec.id));

  const data: ConnectData = {
    orgId: owner.membership.orgId,
    role,
    status,
    connections,
    ...(await stepData(spec, role)),
  };

  return (
    <>
      <PageHeader title={`Connect ${spec.label}`} context="Connected apps" />
      <ConnectFlow appId={spec.id as ConnectableApp} data={data} />
    </>
  );
}

/**
 * What this app's steps need, fetched in one pass - and only for the apps
 * that need it. A Google flow does not pay for the lead-source catalogue.
 */
async function stepData(spec: IntegrationSpec, role: OwnerRole): Promise<Partial<ConnectData>> {
  switch (spec.id) {
    case "google_workspace":
    case "microsoft_365":
    case "smtp": {
      const [providers, oauthApps] = await Promise.all([
        ownerGet<{ providers: ProviderView[] }>("/v1/connections/providers"),
        spec.oauthProvider && role === "owner"
          ? ownerGet<OAuthAppsView>("/v1/connections/oauth-apps")
          : Promise.resolve(null),
      ]);
      return { providers: providers?.providers ?? [], oauthApps };
    }
    case "whatsapp_waba":
      return { signup: await embeddedSignupConfigAction() };
    case "web_forms":
    case "cti":
    // Meta Lead Ads offers the webhook-relay route beside its sign-in.
    case "meta_lead_ads": {
      const [catalogue, sources] = await Promise.all([
        ownerGet<{ channels: CatalogueChannel[] }>("/v1/lead-sources/catalogue"),
        ownerGet<{ sources: LeadSourceRow[] }>("/v1/lead-sources"),
      ]);
      return {
        channels: catalogue?.channels ?? [],
        sources: sources?.sources ?? [],
        intakeOrigin: publicApiOrigin(),
      };
    }
    case "superfone":
    case "google_sheets": {
      const sources = await ownerGet<{ sources: LeadSourceRow[] }>("/v1/lead-sources");
      return { sources: sources?.sources ?? [], intakeOrigin: publicApiOrigin() };
    }
    case "razorpay": {
      const payments = await ownerGet<{ settings: PaymentSettings }>("/v1/owner/payment-settings");
      return { payments: payments?.settings ?? null };
    }
    default:
      return {};
  }
}
