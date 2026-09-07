/**
 * Sending through Meta: WhatsApp Cloud API, Instagram Direct and Messenger.
 *
 * ── EVERY SEND HERE IS A PERSON PRESSING A BUTTON ───────────────────────────
 *
 * Nothing in the worker calls this file, and nothing should. Safety rule 3 -
 * nothing automated sends - is what keeps a bug in a sweep from messaging a
 * customer, and the enforcement is structural: this module lives in the API,
 * reached only from a route that requires a signed-in principal, and the
 * automation engine has no send action at all. A future caller from a timer
 * would have to move this file.
 *
 * ── THE GRAPH VERSION IS PINNED ─────────────────────────────────────────────
 *
 * Meta deprecates versions on a schedule and changes payload shapes between
 * them. An unpinned `/latest` would mean a working integration breaking on
 * Meta's calendar rather than ours, with no commit to blame.
 */

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";

export class MetaSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Meta's own error code, which is what its docs are indexed by. */
    readonly code: number | null,
  ) {
    super(message);
    this.name = "MetaSendError";
  }
}

export interface MetaChannelCredentials {
  accessToken: string;
  /** WhatsApp: the phone number id. IG/Messenger: the page id. */
  senderId: string;
}

export type MetaOutgoing =
  | { type: "text"; to: string; body: string }
  | {
      type: "template";
      to: string;
      template: string;
      language: string;
      /** Positional {{1}}, {{2}} values, in order. */
      params: string[];
    };

export interface MetaSendResult {
  externalId: string;
}

/**
 * WhatsApp Cloud API.
 *
 * A template send and a text send are different request bodies against the
 * same endpoint, and the difference matters operationally rather than
 * cosmetically: outside the 24-hour window Meta refuses a text and accepts
 * only an approved template. The console decides which to offer from
 * `replyWindow()`; this function does what it is told and surfaces Meta's
 * refusal verbatim if the console got it wrong.
 */
export async function sendWhatsAppCloud(
  credentials: MetaChannelCredentials,
  message: MetaOutgoing,
  fetchImpl: typeof fetch = fetch,
): Promise<MetaSendResult> {
  const payload =
    message.type === "template"
      ? {
          messaging_product: "whatsapp",
          to: message.to,
          type: "template",
          template: {
            name: message.template,
            language: { code: message.language },
            // Positional parameters, in one BODY component. Meta's format, and
            // the reason `variables` on message_templates records the order:
            // there are no names here, only a sequence, so getting the order
            // wrong sends the customer somebody else's numbers.
            components: message.params.length
              ? [
                  {
                    type: "body",
                    parameters: message.params.map((text) => ({ type: "text", text })),
                  },
                ]
              : [],
          },
        }
      : {
          messaging_product: "whatsapp",
          to: message.to,
          type: "text",
          // Link previews off: a preview fetch is a request Meta makes on the
          // customer's behalf from a link in OUR message, and its failure modes
          // are somebody else's server.
          text: { body: message.body, preview_url: false },
        };

  const body = await graph(
    `${credentials.senderId}/messages`,
    credentials.accessToken,
    payload,
    fetchImpl,
  );
  const id = (body as { messages?: Array<{ id?: string }> }).messages?.[0]?.id;
  if (!id) throw new MetaSendError("Meta accepted the send but returned no message id", 502, null);
  return { externalId: id };
}

/**
 * Instagram Direct and Messenger.
 *
 * One function, because the Send API is identical for both once the page id is
 * known - which is the mirror of the receive side, where they differ only by
 * the `object` field. Templates do not exist here at all: outside the window
 * these channels allow a permitted message tag or nothing, and Aura offers
 * nothing rather than picking a tag on the tenant's behalf. A tag asserts a
 * REASON for messaging somebody outside the window ("your order shipped"), and
 * asserting that on a customer's behalf is exactly the class of claim this
 * product does not make automatically.
 */
export async function sendMetaDirect(
  credentials: MetaChannelCredentials,
  to: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MetaSendResult> {
  const body = await graph(
    `${credentials.senderId}/messages`,
    credentials.accessToken,
    {
      recipient: { id: to },
      message: { text },
      // RESPONSE, not UPDATE or MESSAGE_TAG: this is a reply to something the
      // person sent, inside the window. It is the only type that needs no
      // further justification, and it is the only one Aura sends.
      messaging_type: "RESPONSE",
    },
    fetchImpl,
  );
  const id = (body as { message_id?: string }).message_id;
  if (!id) throw new MetaSendError("Meta accepted the send but returned no message id", 502, null);
  return { externalId: id };
}

/**
 * Approved templates for a WhatsApp business account.
 *
 * Read rather than pushed: Aura never submits a template for approval. Writing
 * marketing copy that Meta will review and attach to the tenant's business
 * account is a decision with consequences for their number's standing, and it
 * belongs in Meta's own tooling where the review state is authoritative.
 */
export async function listWabaTemplates(
  accessToken: string,
  businessAccountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  Array<{
    id: string;
    name: string;
    language: string;
    status: string;
    category: string | null;
    components: unknown[];
  }>
> {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(businessAccountId)}` +
    `/message_templates?limit=200&fields=id,name,language,status,category,components`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw await metaError(res);
  }
  const body = (await res.json()) as {
    data?: Array<{
      id: string;
      name: string;
      language: string;
      status: string;
      category?: string;
      components?: unknown[];
    }>;
  };
  return (body.data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category ?? null,
    components: t.components ?? [],
  }));
}

async function graph(
  path: string,
  accessToken: string,
  payload: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw await metaError(res);
  return res.json();
}

/**
 * Meta's refusal, in Meta's own words.
 *
 * Surfaced verbatim rather than replaced with "send failed", because these are
 * the messages a person can act on - "Template name does not exist in the
 * translation", "Message failed to send because more than 24 hours have passed
 * since the customer last replied" - and a generic error turns each of them
 * into a support ticket.
 */
async function metaError(res: Response): Promise<MetaSendError> {
  const detail = (await res.json().catch(() => null)) as {
    error?: { message?: string; code?: number; error_user_msg?: string };
  } | null;
  const error = detail?.error;
  return new MetaSendError(
    error?.error_user_msg ?? error?.message ?? `HTTP ${res.status}`,
    res.status,
    error?.code ?? null,
  );
}
