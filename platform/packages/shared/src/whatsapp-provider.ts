import { z } from "zod";

/**
 * The WhatsApp provider a tenant is provisioned on (migration 0104).
 *
 * Split out of the old `org-features.ts` when that module's other half - a
 * second catalogue of console features - was retired in favour of
 * `features.ts`, which answers the same question with an entitlement, a
 * per-client override row and one resolver shared by all three tiers. Only the
 * provider catalogue survived, because nothing else expresses it.
 *
 * Which platform a tenant's WhatsApp Business number is connected through.
 *
 * `none` is not "no WhatsApp" as a product decision - it is the honest state
 * of a tenant nobody has provisioned yet, and it is the default, because a
 * tenant with a provider set but no channel behind it looks configured and is
 * not. `wasi` is the only real value today: Aura is a Hub API client of Wasi
 * and never talks to Meta's Graph API itself.
 *
 * A `meta` member is deliberately NOT catalogued yet. Adding the name before
 * the integration exists would put a selectable option in an operator's dropdown
 * that silently does nothing - the same failure the branding page's
 * `loginBackgroundUrl` was deleted for.
 */
export const WhatsAppProvider = z.enum(["none", "wasi"]);
export type WhatsAppProvider = z.infer<typeof WhatsAppProvider>;

export interface WhatsAppProviderSpec {
  id: WhatsAppProvider;
  label: string;
  blurb: string;
  /** Does choosing this offer the client an in-app connect flow? */
  embeddedSignup: boolean;
}

export const WHATSAPP_PROVIDERS: WhatsAppProviderSpec[] = [
  {
    id: "none",
    label: "Not connected",
    blurb: "No WhatsApp provider. The client's WhatsApp Setup page explains that and offers nothing.",
    embeddedSignup: false,
  },
  {
    id: "wasi",
    label: "Wasi",
    blurb:
      "Sirah's own WhatsApp Business Solution Provider platform. The client connects their Facebook Business account in-app; Aura never touches Meta's Graph API itself.",
    embeddedSignup: true,
  },
];

export function whatsAppProviderSpec(id: string): WhatsAppProviderSpec | undefined {
  return WHATSAPP_PROVIDERS.find((p) => p.id === id);
}

