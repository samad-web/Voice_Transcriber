import type { AppConnection, IntegrationSpec, IntegrationStatus, OwnerRole } from "@aura/shared";
import type { OAuthAppsView, ProviderView } from "../../connections/actions";
import type { PaymentSettings } from "../../invoices/actions";
import type { CatalogueChannel, LeadSourceRow } from "../../lead-sources/page";
import type { EmbeddedSignupConfig } from "../../messaging-setup/actions";
import type { ConnectStep } from "./steps";

/**
 * What the connect route fetched on the server for this app's steps. Each
 * field is filled only for the apps that use it - the route knows which, so
 * a Google flow never pays for the lead-source catalogue.
 */
export interface ConnectData {
  orgId: string;
  role: OwnerRole;
  status: IntegrationStatus;
  connections: AppConnection[];
  /** The connection providers, with their fields and whether each is configured (email apps). */
  providers?: ProviderView[];
  /** The organisation's own sign-in apps (0120) - the owner's, for an app that needs one. */
  oauthApps?: OAuthAppsView | null;
  /** WhatsApp's Embedded Signup readiness (whatsapp_waba). */
  signup?: EmbeddedSignupConfig;
  /** The lead-source catalogue (web_forms, cti). */
  channels?: CatalogueChannel[];
  /** The org's lead sources (google_sheets lists its sheets). */
  sources?: LeadSourceRow[];
  /** The public origin intake addresses live on. */
  intakeOrigin?: string;
  /** Razorpay's saved settings (never the secrets). */
  payments?: PaymentSettings | null;
}

/** What every step component is handed by the flow. */
export interface StepProps {
  spec: IntegrationSpec;
  data: ConnectData;
  /** One-shot values a callback or an earlier step put in the URL. */
  params: {
    /** The row a sign-in or a create left for this flow to finish: a pending choice, a channel, a source. */
    pending: string | null;
    /** The account an OAuth return reports (Google, Microsoft). */
    connected: string | null;
    /** A door's preselection (Messaging page → "through Wasi"). */
    via: string | null;
  };
  /** To the next step of this app's plan; `extra` sets (or, with null, clears) query values. */
  next: (extra?: Record<string, string | null>) => void;
  goTo: (step: ConnectStep, extra?: Record<string, string | null>) => void;
  /** Surface a failure above the step, in orange. */
  fail: (message: string) => void;
}
