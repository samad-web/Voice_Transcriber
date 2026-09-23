import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { decryptSecret } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import {
  WasiOnboardingUnavailableError,
  WasiSendError,
  completeWasiSignup,
  type WasiChannel,
} from "./wasi-client";

/**
 * WhatsApp Embedded Signup - the client connects their own Facebook Business
 * account and WhatsApp number from inside Aura, instead of an operator pasting
 * a number and credentials on their behalf.
 *
 * ── WHO DOES WHAT ───────────────────────────────────────────────────────────
 *
 * The BROWSER runs Meta's JS SDK against Wasi's Meta app, and comes back with
 * a one-time `code` plus the `waba_id`/`phone_number_id` Meta posts back.
 * THIS forwards that triple to Wasi and records the outcome.
 * WASI exchanges the code for a long-lived token using its own app secret.
 *
 * Aura never sees a Meta access token and never calls the Graph API - the same
 * boundary the rest of the Wasi client keeps, and the reason `GET` below hands
 * out only an app id and a config id, which Meta treats as public.
 *
 * ── WHY IT NEEDS A CHANNEL ROW FIRST ────────────────────────────────────────
 *
 * Two different things get connected here and they are easy to conflate. The
 * Hub API key and `client_id` say WHICH WASI ACCOUNT this tenant is - Wasi
 * issues those out of band, per client, and there is no self-serve way to mint
 * them. Embedded Signup says WHICH WHATSAPP NUMBER that account owns.
 *
 * The second cannot happen without the first: the forward to Wasi authenticates
 * with that Hub key, and there is nobody to ask without it. So `GET` reports
 * `ready: false` with a reason rather than offering a button that would fail,
 * and `POST` refuses with a 409 that names the missing step.
 */

/** Meta's public app + login-configuration ids for Wasi's app. */
const META_APP_ID = process.env.WASI_META_APP_ID ?? "";
const META_CONFIG_ID = process.env.WASI_META_CONFIG_ID ?? "";

const CompleteBody = z.object({
  /** Meta's one-time authorization code from `FB.login`. */
  code: z.string().min(10).max(1000),
  wabaId: z.string().min(1).max(64),
  phoneNumberId: z.string().min(1).max(64),
  /**
   * Which completion event Meta fired. Coexistence keeps the business on the
   * WhatsApp Business app on their phone, and Wasi must NOT re-register such a
   * number - see completeWasiSignup. Nothing in the ids distinguishes the two
   * paths after the fact, so the browser reports it or it is lost.
   */
  viaCoexistence: z.boolean().default(false),
});

interface WasiChannelRow {
  id: string;
  api_key: string | null;
  api_base_url: string | null;
  config: Record<string, unknown> | null;
  inbound_address: string;
  status: string;
}

@Controller("messaging/embedded-signup")
@UseGuards(AdminKeyGuard, TenantGuard)
export class EmbeddedSignupController {
  constructor(private readonly db: DbService) {}

  /**
   * Everything the browser needs to decide whether to offer the button, and to
   * run `FB.login` if it does.
   *
   * Deliberately answers for an org with no provider and no channel rather
   * than 404ing: "you are not set up for this" is a state the page has to
   * render, not an error it has to handle.
   */
  @Get()
  async config(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query(
        `SELECT whatsapp_provider FROM organizations WHERE id = $1`,
        [orgId],
      );
      const provider: string = org?.whatsapp_provider ?? "none";

      const {
        rows: [channel],
      } = await client.query(
        `SELECT id, api_key, api_base_url, config, inbound_address, status
           FROM messaging_channels
          WHERE org_id = $1 AND channel = 'whatsapp' AND provider = 'wasi'
          ORDER BY created_at ASC LIMIT 1`,
        [orgId],
      );

      const row = channel as WasiChannelRow | undefined;
      const hasHubCredentials = Boolean(row?.api_key && row?.api_base_url);
      const metaConfigured = Boolean(META_APP_ID && META_CONFIG_ID);

      return {
        provider,
        // The three preconditions, reported separately so the console can say
        // which one is missing. Collapsing them into one boolean would make
        // "your operator has not chosen a provider" and "this deployment has
        // no Meta app configured" the same message, and they are fixed by
        // different people.
        providerIsWasi: provider === "wasi",
        metaConfigured,
        hasHubCredentials,
        ready: provider === "wasi" && metaConfigured && hasHubCredentials,
        appId: metaConfigured ? META_APP_ID : null,
        configId: metaConfigured ? META_CONFIG_ID : null,
        connected: row ? isConnected(row) : false,
        connectedNumber: row && isConnected(row) ? row.inbound_address : null,
      };
    });
  }

  /**
   * Finish a signup the browser has completed with Meta.
   *
   * ── WHY THE RESULT IS RECORDED BEFORE THE FORWARD ───────────────────────
   *
   * The `code` is single-use and short-lived, and the forward to Wasi is the
   * step most likely to fail (see completeWasiSignup on the endpoint that does
   * not exist yet). If that throws and nothing was written, the person's only
   * recourse is to run the whole Facebook popup again - and every field Meta
   * gave us, including which WABA and which number they picked, is gone.
   *
   * So the ids land in `messaging_channel_events` first, always. Worst case an
   * operator finishes the connection by hand on Wasi's side with the exact
   * values in front of them, instead of asking the customer to do it again.
   * The `code` itself is NOT stored: it is a credential, it expires in
   * minutes, and it is useless to anyone reading the log later.
   */
  @Post()
  async complete(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CompleteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const signup = parsed.data;

    const channel = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query(`SELECT whatsapp_provider FROM organizations WHERE id = $1`, [orgId]);
      if ((org?.whatsapp_provider ?? "none") !== "wasi") {
        throw new ConflictException(
          "This workspace is not provisioned for Wasi. Ask your provider to set the WhatsApp provider first.",
        );
      }

      const {
        rows: [row],
      } = await client.query(
        `SELECT id, api_key, api_base_url, config, inbound_address, status
           FROM messaging_channels
          WHERE org_id = $1 AND channel = 'whatsapp' AND provider = 'wasi'
          ORDER BY created_at ASC LIMIT 1`,
        [orgId],
      );
      if (!row) {
        throw new ConflictException(
          "No Wasi account is linked to this workspace yet. The Hub API key and client id have to be in place before a number can be connected.",
        );
      }

      await client.query(
        `INSERT INTO messaging_channel_events (org_id, messaging_channel_id, event, payload)
         VALUES ($1, $2, 'embedded_signup.received', $3::jsonb)`,
        [
          orgId,
          row.id,
          JSON.stringify({
            wabaId: signup.wabaId,
            phoneNumberId: signup.phoneNumberId,
            viaCoexistence: signup.viaCoexistence,
          }),
        ],
      );

      return row as WasiChannelRow;
    });

    if (!channel.api_key || !channel.api_base_url) {
      throw new ConflictException(
        "The linked Wasi account is missing its Hub API key or base URL, so the connection cannot be completed.",
      );
    }

    const wasi: WasiChannel = {
      apiBaseUrl: channel.api_base_url,
      apiKey: decryptSecret(channel.api_key) ?? "",
      // `wasiClientId` is the key the console, the channels controller and the
      // OTP sender all write and read. This read `client_id`, so a channel the
      // console created handed Wasi an empty client id (doc 28 §16, 6e).
      // `client_id` stays as a fallback for a row an older build wrote.
      wasiClientId: String(channel.config?.wasiClientId ?? channel.config?.client_id ?? ""),
    };

    let result;
    try {
      result = await completeWasiSignup(wasi, {
        code: signup.code,
        wabaId: signup.wabaId,
        phoneNumberId: signup.phoneNumberId,
        viaCoexistence: signup.viaCoexistence,
      });
    } catch (err) {
      await this.recordFailure(orgId, channel.id, err);
      if (err instanceof WasiOnboardingUnavailableError) {
        // 409, not 502: nothing is broken and retrying will not help. The
        // provider has not enabled this path, which is a decision somebody has
        // to make, and the console prints the message verbatim so they can.
        throw new ConflictException(err.message);
      }
      if (err instanceof WasiSendError) throw new ConflictException(err.message);
      throw err;
    }

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE messaging_channels
            SET inbound_address = COALESCE($3, inbound_address),
                display_name    = COALESCE($4, display_name),
                -- Merged, not replaced: wasiClientId and anything else an
                -- operator put here has to survive a number being connected.
                config          = config || $5::jsonb,
                status          = 'active',
                updated_at      = now()
          WHERE id = $2 AND org_id = $1
         RETURNING id, inbound_address, display_name, status`,
        [
          orgId,
          channel.id,
          result.displayPhoneNumber,
          result.displayName,
          JSON.stringify({
            waba_id: result.wabaId,
            phone_number_id: result.phoneNumberId,
            ...(result.wasiClientId ? { wasiClientId: result.wasiClientId } : {}),
            connected_via: "embedded_signup",
            connected_at: new Date().toISOString(),
          }),
        ],
      );

      await client.query(
        `INSERT INTO messaging_channel_events (org_id, messaging_channel_id, event, payload)
         VALUES ($1, $2, 'embedded_signup.connected', $3::jsonb)`,
        [orgId, channel.id, JSON.stringify(result)],
      );

      return { connected: true, channel: updated };
    });
  }

  /**
   * Log a failed handoff against the channel.
   *
   * Its own transaction, and swallowing its own errors: this runs on the way
   * to throwing something the caller needs to see, and a logging failure must
   * not replace a precise "Wasi has not enabled this route" with a database
   * error about the log.
   */
  private async recordFailure(orgId: string, channelId: string, err: unknown): Promise<void> {
    try {
      await this.db.withOrg(orgId, async (client) => {
        await client.query(
          `INSERT INTO messaging_channel_events (org_id, messaging_channel_id, event, payload)
           VALUES ($1, $2, 'embedded_signup.failed', $3::jsonb)`,
          [orgId, channelId, JSON.stringify({ error: (err as Error).message ?? "unknown" })],
        );
      });
    } catch {
      /* see the note above */
    }
  }
}

/** A channel is connected once Wasi has told us a real number for it. */
function isConnected(row: WasiChannelRow): boolean {
  const config = row.config ?? {};
  return row.status === "active" && Boolean(config.phone_number_id);
}
