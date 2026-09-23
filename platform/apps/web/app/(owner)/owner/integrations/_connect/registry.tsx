import type { ComponentType } from "react";
import { OAuthAccountAuth, OAuthAccountCheck, SmtpAuth } from "./adapters/email-accounts";
import { SheetsAuth, SourceCheck, SuperfoneAuth, WebhookSourceAuth } from "./adapters/lead-sources";
import { LinkedInAuth, LinkedInChoose } from "./adapters/linkedin";
import { ChannelCheck, MetaMessagingAuth, WhatsAppBusinessAuth } from "./adapters/messaging";
import { MetaLeadsAuth, MetaLeadsChoose } from "./adapters/meta-lead-ads";
import { PersonalWhatsAppAuth } from "./adapters/personal-whatsapp";
import { RazorpayAuth } from "./adapters/razorpay";
import type { ConnectStep, ConnectableApp } from "./steps";
import type { StepProps } from "./types";

/**
 * Which component draws each app's middle steps (doc 28 §11.2). Typed against
 * CONNECT_PLANS, so an app with a plan and no components does not compile.
 *
 * Every component here WRAPS the UI its old page used - moved, not rewritten.
 * `unframed` names the steps whose hosted component already draws its own
 * card (the Sheets panel, Superfone's panel, the payment-account card); the
 * flow does not put a second card around them.
 */
export interface ConnectAdapter {
  Auth: ComponentType<StepProps>;
  Choose?: ComponentType<StepProps>;
  Check?: ComponentType<StepProps>;
  unframed?: readonly ConnectStep[];
}

export const ADAPTERS: Record<ConnectableApp, ConnectAdapter> = {
  whatsapp_waba: { Auth: WhatsAppBusinessAuth, Check: ChannelCheck },
  instagram: { Auth: MetaMessagingAuth, Check: ChannelCheck },
  facebook_messenger: { Auth: MetaMessagingAuth, Check: ChannelCheck },
  whatsapp_personal: { Auth: PersonalWhatsAppAuth },

  meta_lead_ads: { Auth: MetaLeadsAuth, Choose: MetaLeadsChoose },
  google_sheets: { Auth: SheetsAuth, unframed: ["auth"] },
  linkedin_ads: { Auth: LinkedInAuth, Choose: LinkedInChoose },
  web_forms: { Auth: WebhookSourceAuth, Check: SourceCheck },

  razorpay: { Auth: RazorpayAuth, unframed: ["auth"] },

  superfone: { Auth: SuperfoneAuth, Check: SourceCheck, unframed: ["auth"] },
  cti: { Auth: WebhookSourceAuth, Check: SourceCheck },

  google_workspace: { Auth: OAuthAccountAuth, Check: OAuthAccountCheck },
  microsoft_365: { Auth: OAuthAccountAuth, Check: OAuthAccountCheck },
  smtp: { Auth: SmtpAuth },
};
