import { BadRequestException } from "@nestjs/common";
import { decryptSecret } from "@aura/db";
import { sendWasiMessage, WasiSendError } from "../conversations/wasi-client";
import { MetaSendError, sendWhatsAppCloud } from "../conversations/meta-send";

/**
 * Carrying a one-time code to a customer's administrator over WhatsApp.
 *
 * ── THE SAFETY POSITION ───────────────────────────────────────────────────
 *
 * This is the only thing in the call-access feature that puts a message in
 * front of a real human being. Everything else is in-app: a bell in a console
 * somebody has already signed in to.
 *
 * It is therefore off by default at TWO independent switches, checked by the
 * caller before this function is reached:
 *
 *   CALL_ACCESS_OTP_ENABLED   this feature specifically
 *   WHATSAPP_SENDING_ENABLED  the deployment's existing switch for ALL
 *                             outbound WhatsApp
 *
 * Neither defaults to true and neither is set by any compose file or
 * `.env.*.example` in this repository. A deployment that does nothing sends
 * nothing, and the console-approval path - which touches no channel at all -
 * remains the way this feature works out of the box.
 *
 * ── WHO RECEIVES IT ───────────────────────────────────────────────────────
 *
 * The tenant's OWN administrator, on the number their own colleague entered in
 * `memberships.phone` (0102) - never a lead, never a customer of theirs, never
 * anybody who has not already been given a login to this product. That is a
 * materially different recipient from the marketing paths, and it is the
 * reason this is defensible at all; it is not a licence to widen it later.
 *
 * ── WHAT IT SAYS, AND WHY IT SAYS IT ──────────────────────────────────────
 *
 * The message states who is asking, why, exactly what window they would get,
 * and that the code is the thing that grants it. A bare "your code is 482913"
 * would be a request for consent that withholds what is being consented to -
 * which is worse than not asking, because it produces a yes that means
 * nothing. It also tells them what to do if they did not expect it, because
 * the one person who most needs an instruction is the one being socially
 * engineered.
 */

export interface CallAccessOtpMessage {
  orgId: string;
  toPhone: string;
  code: string;
  operatorEmail: string;
  reason: string;
  windowStart: Date;
  windowEnd: Date;
}

type Queryable = {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
};

/**
 * The exact text a person receives. Exported so a test can assert it and a
 * human can read it without running anything - the wording of a consent
 * request is not an implementation detail.
 */
export function renderCallAccessOtpMessage(input: {
  code: string;
  operatorEmail: string;
  reason: string;
  windowStart: Date;
  windowEnd: Date;
  orgName: string;
}): string {
  return [
    `${input.code} is your Aura approval code.`,
    ``,
    `${input.operatorEmail} is asking to view ${input.orgName}'s call logs, recordings and transcripts.`,
    `Reason given: ${input.reason}`,
    `If approved, they could see them from ${formatWhen(input.windowStart)} until ${formatWhen(input.windowEnd)}, and not after that.`,
    ``,
    `Share this code only if you want to allow it. If you did not expect this, ignore this message and nothing will be shared.`,
  ].join("\n");
}

/**
 * Send it, through whichever transport this org's WhatsApp channel uses.
 *
 * Reuses the org's own `messaging_channels` row rather than introducing a
 * platform-level sender: there is no platform WhatsApp number in this product,
 * and inventing one here would be a new outbound identity nobody asked for. An
 * org with no active channel simply cannot use codes, and the caller turns
 * that into a sentence pointing at console approval.
 *
 * Deliberately does NOT consult `messaging_opt_outs`. That table records a
 * CUSTOMER asking a tenant to stop marketing at them; this is a tenant's own
 * administrator receiving a security code about their own account, and reading
 * a marketing opt-out as consent-to-nothing here would silently disable the
 * approval path for the person it belongs to. It also does not count against
 * the daily marketing cap, for the same reason.
 */
export async function sendCallAccessOtp(
  client: Queryable,
  input: CallAccessOtpMessage,
): Promise<void> {
  const {
    rows: [org],
  } = await client.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [
    input.orgId,
  ]);

  const {
    rows: [channel],
  } = await client.query<{
    provider: string;
    status: string;
    api_key: string | null;
    api_base_url: string | null;
    config: { wasiClientId?: string; phoneNumberId?: string };
  }>(
    `SELECT provider, status, api_key, api_base_url, config
       FROM messaging_channels
      WHERE org_id = $1 AND channel = 'whatsapp' AND status = 'active'
      ORDER BY created_at
      LIMIT 1`,
    [input.orgId],
  );

  if (!channel) {
    throw new BadRequestException(
      "this organisation has no active WhatsApp channel, so no code can be sent - " +
        "ask the administrator to approve from their console instead",
    );
  }

  const body = renderCallAccessOtpMessage({
    code: input.code,
    operatorEmail: input.operatorEmail,
    reason: input.reason,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    orgName: org?.name ?? "your organisation",
  });

  const isMeta = channel.provider === "waba" || channel.provider === "meta";

  try {
    if (isMeta) {
      if (!channel.api_key || !channel.config?.phoneNumberId) {
        throw new BadRequestException("this WhatsApp channel is missing its Cloud API credentials");
      }
      await sendWhatsAppCloud(
        {
          accessToken: decryptSecret(channel.api_key) ?? "",
          senderId: channel.config.phoneNumberId,
        },
        { type: "text", to: input.toPhone, body },
      );
      return;
    }

    if (channel.provider !== "wasi") {
      throw new BadRequestException(`sending through ${channel.provider} is not supported`);
    }
    if (!channel.api_key || !channel.api_base_url || !channel.config?.wasiClientId) {
      throw new BadRequestException("this org's WhatsApp channel is missing its Wasi credentials");
    }
    await sendWasiMessage(
      {
        apiBaseUrl: channel.api_base_url,
        apiKey: decryptSecret(channel.api_key) ?? "",
        wasiClientId: channel.config.wasiClientId,
      },
      { type: "text", to: input.toPhone, body },
    );
  } catch (err) {
    // The provider's own words are what a person can act on - same handling
    // as the reply path in whatsapp-send.controller.ts.
    if (err instanceof WasiSendError) {
      throw new BadRequestException(`Wasi refused the send: ${err.message}`);
    }
    if (err instanceof MetaSendError) {
      throw new BadRequestException(`Meta refused the send: ${err.message}`);
    }
    throw err;
  }
}

/**
 * A time a person can read, in the only format that cannot be misread.
 *
 * Deliberately not "in 4 hours" or a bare "18:00": this sentence is the whole
 * of what somebody is agreeing to, it arrives on a phone that may be in a
 * different timezone from the console that composed it, and "18:00" with no
 * date has burned more than one on-call engineer. UTC is stated explicitly
 * rather than rendered in the org's reporting timezone, because the message is
 * composed on the server and a timezone we guessed wrong would be worse than
 * one we named.
 */
function formatWhen(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
