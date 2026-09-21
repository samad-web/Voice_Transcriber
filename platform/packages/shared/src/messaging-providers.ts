import { z } from "zod";

/**
 * WHICH KIND OF WHATSAPP ACCOUNT IS THIS, AND WHAT FOLLOWS FROM THAT.
 *
 * ── NOT TO BE CONFUSED WITH `whatsapp-provider.ts` ──────────────────────────
 *
 * There is a near-namesake next door and the two answer different questions.
 *
 *   whatsapp-provider.ts  is `organizations.whatsapp_provider` (0104) - the
 *     operator's INTENT for a tenant, set before anything is connected, which
 *     decides which connect flow the client is offered. Values `none` | `wasi`.
 *   THIS FILE            is `messaging_channels.provider` (0056) - what an
 *     EXISTING connection actually runs on. Values `waba` | `wasi` |
 *     `evolution` | `meta`.
 *
 * This one is named for the column it describes rather than for WhatsApp,
 * because `meta` is in it and Instagram and Messenger are not WhatsApp at all.
 *
 * ── THE CONFUSION THIS FILE EXISTS TO END ───────────────────────────────────
 *
 * There are two completely different ways to reach WhatsApp and the product has
 * been treating them as one. They are:
 *
 *   A BUSINESS account (WABA) - Meta's official API. Either direct against the
 *     Cloud API (`waba`) or resold by a Business Solution Provider (`wasi`, the
 *     operator's own BSP). Needs Meta approval and a verified business, gives
 *     approved templates, and enforces the 24-hour session window.
 *
 *   A PERSONAL account (`evolution`) - an ordinary WhatsApp account linked the
 *     same way WhatsApp Web links one, driven server-side over the multi-device
 *     protocol. Needs no approval and no business verification, has no templates
 *     and no session window, and is unofficial: the account can be rate-limited
 *     or banned with no support channel.
 *
 * Those are not two configurations of one thing. Every rule that matters -
 * whether a template exists, whether free text may leave, what authenticates an
 * inbound delivery, what a failed probe means - differs between them.
 *
 * ── WHY IT IS A TABLE AND NOT A SET OF `if`s ────────────────────────────────
 *
 * Because the `if`s were already there, spread across seven files, and they had
 * drifted into being wrong in three separate ways:
 *
 *   1. `messaging-window.ts` gated the 24-hour rule on the provider name
 *      `meta_cloud`, which no channel has ever been given - the real name is
 *      `waba`. So the window silently never applied to the one provider that
 *      enforces it hardest, and the test pinned the fictional name, which made
 *      the gap look covered.
 *   2. `integrations.controller.ts` reported `wasi` under the PERSONAL number
 *      card. Wasi is a BSP: it is a WABA, with Embedded Signup and templates.
 *      A business connection lit up the "personal number" row.
 *   3. `channel-health.ts` spoke only Wasi's vocabulary, so a healthy personal
 *      channel was told - critically - that its replies were being discarded,
 *      on the strength of a forward secret it does not need.
 *
 * One table, imported by the API, the console and the worker, is the same
 * argument `features.ts`, `org-modules.ts` and `connection-providers.ts` each
 * make for themselves. The failure mode it removes is the one above: three
 * files disagreeing about what a provider IS, with nothing failing.
 */

/**
 * What sort of WhatsApp account sits behind a channel.
 *
 * This is the distinction the product sells on and the one a customer
 * understands: "my business number, through Meta" or "my own WhatsApp".
 */
export const WhatsAppAccountKind = z.enum(["waba", "personal"]);
export type WhatsAppAccountKind = z.infer<typeof WhatsAppAccountKind>;

/**
 * Every value `messaging_channels.provider` may hold.
 *
 * `meta` is in here and is deliberately NOT a WhatsApp account of either kind:
 * it carries Instagram Direct and Facebook Messenger, which share Meta's
 * webhook and signature scheme but are not WhatsApp. Leaving it out would mean
 * every caller had to handle "not in the table" as a separate case, which is
 * how `provider` became an unvalidated free string in the first place.
 */
export const MessagingProvider = z.enum(["waba", "wasi", "evolution", "meta"]);
export type MessagingProvider = z.infer<typeof MessagingProvider>;

/**
 * How an inbound delivery on this provider is authenticated.
 *
 * Three values because there are genuinely three schemes, and collapsing them
 * is what produced the false "replies are being discarded" alert:
 *
 *   `meta_signature`  Meta signs with the APP secret, shared across every Page
 *                     and number on the app. Nothing per-channel to configure,
 *                     and an unsigned delivery is REFUSED - an open endpoint
 *                     that writes into a customer's inbox is not acceptable
 *                     just because the URL is hard to guess.
 *   `hmac_required`   Wasi signs per channel with a `forward_secret` it mints.
 *                     Without it every delivery is dropped, so a channel that
 *                     lacks one genuinely cannot receive.
 *   `hmac_optional`   A relay Aura does not control. The `:token` in the URL is
 *                     the credential; a forward secret can be configured on top
 *                     where the relay supports signing, but its ABSENCE is the
 *                     normal, working state - not a fault to alert on.
 */
export const InboundAuthScheme = z.enum(["meta_signature", "hmac_required", "hmac_optional"]);
export type InboundAuthScheme = z.infer<typeof InboundAuthScheme>;

/**
 * How `POST /messaging/channels/:id/verify` asks this provider whether the
 * stored credentials still work.
 *
 * `none` is an honest answer and not a gap: for a Meta channel the credential
 * is a long-lived system-user token whose validity is only meaningfully proven
 * by a Graph call Aura does not otherwise make. Recording `provider_error`
 * instead - which is what the code did before this table existed - put a
 * standing false "No answer" on every healthy WABA channel.
 */
export const ChannelProbeKind = z.enum(["wasi_templates", "evolution_status", "none"]);
export type ChannelProbeKind = z.infer<typeof ChannelProbeKind>;

export interface MessagingProviderSpec {
  id: MessagingProvider;
  /** What a customer is shown. Never the raw enum. */
  label: string;
  /**
   * Which kind of WhatsApp account this reaches, or null when it is not
   * WhatsApp at all (`meta`).
   */
  accountKind: WhatsAppAccountKind | null;
  /** One line, for a settings card. Accurate about the trade, not a pitch. */
  blurb: string;
  /** Approved message templates exist and can be sent. */
  hasTemplates: boolean;
  /**
   * Meta's 24-hour session window applies: outside it, free text is refused
   * and only an approved template leaves.
   */
  hasSessionWindow: boolean;
  /** A Meta review / verified business is a precondition to connecting. */
  requiresMetaApproval: boolean;
  /**
   * Unofficial transport. True only for `evolution`: it drives a real account
   * over the protocol WhatsApp Web speaks, which Meta does not sanction, and
   * the account carries a ban risk. Surfaced in the console rather than buried
   * here - a customer linking their own phone is entitled to know.
   */
  unofficial: boolean;
  inboundAuth: InboundAuthScheme;
  probe: ChannelProbeKind;
}

/**
 * The table. Order is the order the console offers them: official first.
 */
export const MESSAGING_PROVIDERS: MessagingProviderSpec[] = [
  {
    id: "waba",
    label: "WhatsApp Business API",
    accountKind: "waba",
    blurb: "Your verified business number, direct through Meta's Cloud API.",
    hasTemplates: true,
    hasSessionWindow: true,
    requiresMetaApproval: true,
    unofficial: false,
    inboundAuth: "meta_signature",
    probe: "none",
  },
  {
    id: "wasi",
    label: "WhatsApp Business API (via Wasi)",
    accountKind: "waba",
    // Said plainly because the console said the opposite for two releases:
    // this page told people Wasi "needs no Meta approval and has no
    // templates", and both halves are false. Wasi IS a Business Solution
    // Provider - Embedded Signup, a real WABA, approved templates.
    blurb: "Your verified business number, resold through the Wasi platform. Same Meta rules apply.",
    hasTemplates: true,
    hasSessionWindow: true,
    requiresMetaApproval: true,
    unofficial: false,
    inboundAuth: "hmac_required",
    probe: "wasi_templates",
  },
  {
    id: "evolution",
    label: "Personal WhatsApp number",
    accountKind: "personal",
    blurb: "An ordinary WhatsApp account, linked by QR or pairing code like WhatsApp Web.",
    hasTemplates: false,
    hasSessionWindow: false,
    requiresMetaApproval: false,
    unofficial: true,
    inboundAuth: "hmac_optional",
    probe: "evolution_status",
  },
  {
    id: "meta",
    label: "Instagram & Messenger",
    accountKind: null,
    blurb: "Instagram Direct and Facebook Messenger, through the same Meta app.",
    hasTemplates: false,
    hasSessionWindow: true,
    requiresMetaApproval: true,
    unofficial: false,
    inboundAuth: "meta_signature",
    probe: "none",
  },
];

const BY_ID = new Map<string, MessagingProviderSpec>(MESSAGING_PROVIDERS.map((p) => [p.id, p]));

/**
 * The spec for a stored provider value, or undefined.
 *
 * Undefined rather than a throw, and undefined rather than a default. Callers
 * read a value out of a database column that predates the CHECK constraint, so
 * an unrecognised string is a real possibility - and every call site has a
 * different right answer for it. Handing back a plausible default would make
 * the unknown provider behave like `waba` somewhere, which is exactly the class
 * of silent wrongness this module was written to remove.
 */
export function providerSpec(provider: string | null | undefined): MessagingProviderSpec | undefined {
  return provider === null || provider === undefined ? undefined : BY_ID.get(provider);
}

export function isMessagingProvider(v: unknown): v is MessagingProvider {
  return typeof v === "string" && BY_ID.has(v);
}

/**
 * Is this a business (WABA) channel?
 *
 * Unknown providers answer FALSE here and false in `isPersonalWhatsApp` too -
 * a provider nobody has taught the system about is neither, and claiming it is
 * a WABA would extend Meta's rules to a transport that may not have them.
 */
export function isWabaProvider(provider: string | null | undefined): boolean {
  return providerSpec(provider)?.accountKind === "waba";
}

/** Is this a personal, individually-linked WhatsApp account? */
export function isPersonalWhatsApp(provider: string | null | undefined): boolean {
  return providerSpec(provider)?.accountKind === "personal";
}

/**
 * Every provider reaching a given kind of account.
 *
 * This is what the integrations hub groups on. It exists so that adding a
 * second personal transport, or a third BSP, is a row in the table above rather
 * than a hand-maintained string array in a controller - which is precisely how
 * `wasi` ended up listed under "personal number".
 */
export function providersForKind(kind: WhatsAppAccountKind): MessagingProvider[] {
  return MESSAGING_PROVIDERS.filter((p) => p.accountKind === kind).map((p) => p.id);
}

/**
 * Does a forward secret have to be present for inbound to work at all?
 *
 * The question `channel-health.ts` needs, and the one it used to get wrong by
 * assuming every channel was a Wasi channel. Only `hmac_required` genuinely
 * discards deliveries without one; on `meta_signature` the secret is an
 * optional per-tenant override of the app secret, and on `hmac_optional` it is
 * an optional hardening step.
 */
export function inboundNeedsForwardSecret(provider: string | null | undefined): boolean {
  return providerSpec(provider)?.inboundAuth === "hmac_required";
}
