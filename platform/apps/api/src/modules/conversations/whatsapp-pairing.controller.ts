import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@aura/db";
import { normalizePeerAddress } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { threadViewerOf } from "../../common/private-threads";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import {
  EvolutionError,
  connectEvolutionInstance,
  createEvolutionInstance,
  evolutionAdminFromEnv,
  getEvolutionQr,
  getEvolutionStatus,
  logoutEvolutionInstance,
  requestEvolutionPairingCode,
} from "./evolution-client";

/**
 * LINKING A PERSONAL WHATSAPP NUMBER, FROM INSIDE THE CONSOLE.
 *
 * ── WHY THIS IS NOT EMBEDDED SIGNUP, AND NOT THE WASI FORM ──────────────────
 *
 * There are now two ways to connect WhatsApp and they have nothing in common
 * beyond the word.
 *
 * A BUSINESS number is a WABA. It goes through Meta - directly, or through Wasi
 * as a Business Solution Provider - and connecting it means Embedded Signup, a
 * verified business, an approved display name. That is
 * `embedded-signup.controller.ts`, and it is where a business number must stay:
 * a WABA is the only path that gives templates, the 24-hour window and the
 * standing of an official sender.
 *
 * A PERSONAL number cannot go that way at all. Meta publishes no API for an
 * ordinary WhatsApp account and there is no approval to apply for. The only
 * mechanism that exists is the one WhatsApp Web uses: become a linked device.
 * That is what this controller does, through Evolution GO, which is a
 * server-side WhatsApp Web client (see evolution-client.ts, including the
 * measured reason an iframe of web.whatsapp.com is not an option).
 *
 * Keeping them in separate controllers is the point rather than an accident.
 * The old code had one page offering "Connect through Meta" beside "Connect
 * WhatsApp via Wasi" and described the SECOND as the no-approval,
 * no-templates, ordinary-number option - which is false twice over, because
 * Wasi is a WABA. Anyone wanting to link their own phone was routed into a
 * business flow that would refuse them. Two controllers, two flows, and the
 * account kind decides which, is what makes that mistake unavailable.
 *
 * ── ONE NUMBER PER PERSON, AND ITS CHATS ARE THEIRS (0125) ──────────────────
 *
 * A personal number is somebody's own phone, so it is linked BY that person,
 * FROM their own inbox, with no owner in the loop - and every thread that
 * arrives on it is private to them (see common/private-threads.ts). This
 * controller therefore acts only ever on the CALLER's own channel: every route
 * resolves the signed-in person and finds the row by `owner_user_id`. There is
 * no route that takes somebody else's id, so there is no way to link, read or
 * unlink a colleague's number through it.
 *
 * Personas: the four who have an inbox to read the chats in. Marketing has no
 * inbox (nav.ts), and a linked number whose chats its owner can never open is
 * a trap, not a feature.
 *
 * Unlike the Wasi path there is no `organizations.whatsapp_provider` gate. What
 * bounds it is that linking is per-person, reversible from the same card, and
 * carries the ban warning at the moment of pairing rather than in a footnote.
 *
 * ── NOTHING HERE SENDS ──────────────────────────────────────────────────────
 *
 * Safety rule 3 holds. Pairing establishes a session and subscribes a webhook;
 * it puts no message on anybody's phone. The only outbound WhatsApp in the
 * product is still `whatsapp-send.controller.ts`, behind a signed-in human, a
 * permission and a daily cap.
 */

const StartBody = z.object({
  /**
   * The number being linked, for the pairing-code flow and for the channel's
   * `inbound_address`. Normalised the same way every other peer address is, so
   * a number typed with spaces or a `+` threads against the same contact.
   */
  phone: z.string().min(6).max(32),
  displayName: z.string().max(200).optional(),
  /**
   * `code` types eight characters into the phone; `qr` scans. Code is the
   * default because it needs no second device and no camera, and because it is
   * the one that works when somebody is at a desktop with their phone beside
   * them - which is the situation this is used in almost every time.
   */
  method: z.enum(["code", "qr"]).default("code"),
});

/** What the console polls while the person is at their phone. */
interface PairingView {
  connected: boolean;
  /** Present until the link completes, when `method` was `code`. */
  pairingCode?: string | null;
  /** A `data:` image, when `method` was `qr`. */
  qrImage?: string | null;
  /** The raw QR payload when Evolution returned a string rather than an image. */
  qrCode?: string | null;
  number: string | null;
  channelId: string | null;
  /** Free text for the card - never a credential. */
  detail: string | null;
}

@Controller("messaging/whatsapp-personal")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager", "telecaller", "sales")
export class WhatsAppPairingController {
  constructor(private readonly db: DbService) {}

  /**
   * What the page needs on load: is a personal number linked, and if not, can
   * one be?
   *
   * Answers for an org with no channel rather than 404ing, exactly as the
   * Embedded Signup config route does - "you have not done this yet" is a state
   * the page renders, not an error it handles.
   */
  @Get()
  async status(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const me = requirePerson(req);
    const admin = evolutionAdminFromEnv();
    const channel = await this.personalChannel(orgId, me);

    if (!channel) {
      return {
        available: admin !== null,
        connected: false,
        number: null,
        channelId: null,
        detail: admin
          ? null
          : "This deployment has no WhatsApp relay configured, so a personal number cannot be linked. Your provider sets EVOLUTION_BASE_URL and EVOLUTION_ADMIN_API_KEY.",
      };
    }

    // The live answer, not the stored one. `status` on the row is an operator
    // switch; whether the phone is still linked is a question only Evolution
    // can answer, and the commonest way this breaks is somebody clearing
    // Linked Devices on the handset - which changes nothing in our database.
    let connected = false;
    let detail: string | null = null;
    const baseUrl = channel.api_base_url ?? admin?.baseUrl;
    if (channel.api_key && baseUrl) {
      try {
        const live = await getEvolutionStatus({
          baseUrl,
          token: decryptSecret(channel.api_key) ?? "",
        });
        connected = live.connected && live.loggedIn;
        if (!connected) {
          detail = live.loggedIn
            ? "Linked, but not connected to WhatsApp at the moment."
            : "This number is no longer linked. Somebody removed Aura from Linked Devices on the phone.";
        }
      } catch (err) {
        detail = err instanceof EvolutionError ? err.message : "Could not reach the WhatsApp relay.";
      }
    }

    return {
      available: admin !== null,
      connected,
      number: channel.inbound_address,
      channelId: channel.id,
      detail,
    };
  }

  /**
   * Begin linking: make sure the org has an instance, point it at Aura, and
   * hand back the code or QR the person types or scans.
   *
   * ── THE CHANNEL ROW IS WRITTEN BEFORE EVOLUTION IS CALLED ───────────────
   *
   * The instance token is generated here and stored encrypted FIRST, because
   * Evolution never gives it back. It is a value we hand it at create time and
   * can never read again. If the row were written after a successful create and
   * the write failed, the org would own an instance on the relay that nothing
   * in Aura could ever authenticate to - unreachable, unbillable, and
   * invisible until somebody went looking on the relay itself.
   *
   * Written first, the worst case is a channel row whose instance does not
   * exist yet, which the next attempt fixes by creating it (create is
   * idempotent on an existing name).
   */
  @Post()
  async start(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const me = requirePerson(req);
    const parsed = StartBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    const admin = evolutionAdminFromEnv();
    if (!admin) {
      // 503 rather than 400: nothing the caller sent is wrong, and no change to
      // their request will help. This is the operator's to fix.
      throw new ServiceUnavailableException(
        "this deployment has no WhatsApp relay configured (EVOLUTION_BASE_URL, EVOLUTION_ADMIN_API_KEY)",
      );
    }

    const phone = normalizePeerAddress("whatsapp", input.phone);
    if (!phone) throw new BadRequestException("that does not look like a usable phone number");

    const existing = await this.personalChannel(orgId, me);
    if (existing && existing.api_key && (existing.api_base_url ?? admin.baseUrl)) {
      // Already linked and still live? Then this is a no-op, not a re-pair.
      // Re-pairing a working number would drop the session and interrupt a
      // conversation that is currently running.
      try {
        const live = await getEvolutionStatus({
          baseUrl: existing.api_base_url ?? admin.baseUrl,
          token: decryptSecret(existing.api_key) ?? "",
        });
        if (live.connected && live.loggedIn) {
          throw new ConflictException(
            "your WhatsApp number is already linked - unlink it before linking another",
          );
        }
      } catch (err) {
        if (err instanceof ConflictException) throw err;
        /* Not reachable, so fall through and re-pair: that is the repair. */
      }
    }

    // One instance per PERSON per org (0125), named from both ids so a human
    // looking at the relay's instance list can tell whose it is, and so the
    // same person in two organisations gets two instances rather than one
    // session serving both. Never named from the phone number - a number can
    // move between people, an id cannot.
    const instanceName = existing?.config?.evolutionInstance ?? `aura-${orgId}-${me}`;
    const token = existing?.api_key ? (decryptSecret(existing.api_key) ?? newToken()) : newToken();

    const channelId = await this.upsertChannel(orgId, me, {
      id: existing?.id ?? null,
      phone,
      displayName: input.displayName ?? null,
      token,
      baseUrl: admin.baseUrl,
      instanceName,
    });

    const webhookToken = await this.webhookTokenFor(orgId, channelId);
    const instance = { baseUrl: admin.baseUrl, token };

    try {
      await createEvolutionInstance(admin, { name: instanceName, token });
      await connectEvolutionInstance(instance, {
        webhookUrl: this.webhookUrl(webhookToken),
        phone: input.method === "code" ? phone : undefined,
      });

      const view: PairingView = {
        connected: false,
        number: phone,
        channelId,
        detail: null,
      };

      if (input.method === "code") {
        view.pairingCode = await requestEvolutionPairingCode(instance, phone);
      } else {
        const qr = await getEvolutionQr(instance);
        view.qrImage = qr.imageDataUri;
        view.qrCode = qr.code;
        if (!qr.imageDataUri && !qr.code) {
          view.detail = "The relay did not return a QR code. Try the pairing-code method instead.";
        }
      }
      return view;
    } catch (err) {
      if (err instanceof EvolutionError) {
        // The channel row stays. It holds the one value that cannot be
        // recovered - the instance token - and discarding it here would strand
        // whatever was created on the relay.
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
  }

  /**
   * Poll while the person is at their phone.
   *
   * Polled rather than pushed because the alternative is holding a socket open
   * per pairing attempt for a flow that lasts under a minute. Evolution also
   * emits a `CONNECTION` webhook event, which the messaging webhook records -
   * the two agree, and this one is what the page can act on immediately.
   */
  @Get("poll")
  async poll(@OrgId() orgId: string, @Req() req: PrincipalRequest): Promise<PairingView> {
    const me = requirePerson(req);
    const admin = evolutionAdminFromEnv();
    const channel = await this.personalChannel(orgId, me);
    if (!channel || !channel.api_key) {
      return { connected: false, number: null, channelId: null, detail: "Nothing is being linked." };
    }
    const baseUrl = channel.api_base_url ?? admin?.baseUrl;
    if (!baseUrl) {
      return {
        connected: false,
        number: channel.inbound_address,
        channelId: channel.id,
        detail: "This deployment has no WhatsApp relay configured.",
      };
    }

    try {
      const live = await getEvolutionStatus({
        baseUrl,
        token: decryptSecret(channel.api_key) ?? "",
      });
      const connected = live.connected && live.loggedIn;
      if (connected) await this.markLinked(orgId, channel.id, live.name);
      return {
        connected,
        number: channel.inbound_address,
        channelId: channel.id,
        detail: connected ? null : "Waiting for the phone to confirm.",
      };
    } catch (err) {
      return {
        connected: false,
        number: channel.inbound_address,
        channelId: channel.id,
        detail: err instanceof EvolutionError ? err.message : "Could not reach the WhatsApp relay.",
      };
    }
  }

  /**
   * Unlink the number.
   *
   * Logs out on the relay AND disables the channel here, in that order: if the
   * logout fails the channel stays active and the person can try again, which
   * is better than a console that says "disconnected" over a session still
   * receiving their private messages.
   *
   * The conversation history is deliberately untouched. Losing the connection
   * must not delete the correspondence - the same rule 0056 states for
   * `messaging_channel_id ON DELETE SET NULL`.
   */
  @Delete()
  async disconnect(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const me = requirePerson(req);
    const admin = evolutionAdminFromEnv();
    const channel = await this.personalChannel(orgId, me);
    if (!channel) throw new ConflictException("you have no WhatsApp number linked");

    const baseUrl = channel.api_base_url ?? admin?.baseUrl;
    if (channel.api_key && baseUrl) {
      try {
        await logoutEvolutionInstance({
          baseUrl,
          token: decryptSecret(channel.api_key) ?? "",
        });
      } catch (err) {
        throw new ServiceUnavailableException(
          err instanceof EvolutionError
            ? `Could not unlink on the relay: ${err.message}`
            : "Could not reach the WhatsApp relay to unlink this number.",
        );
      }
    }

    await this.db.withOrg(orgId, (client) =>
      client.query(
        `UPDATE messaging_channels
            SET status = 'disabled', updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [channel.id, orgId],
      ),
    );
    return { disconnected: true };
  }

  /* ── helpers ──────────────────────────────────────────────────────────── */

  /** The CALLER's own personal channel - never anybody else's (0125). */
  private async personalChannel(orgId: string, ownerUserId: string): Promise<PersonalChannelRow | null> {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<PersonalChannelRow>(
        `SELECT id, inbound_address, api_key, api_base_url, config, status
           FROM messaging_channels
          WHERE org_id = $1 AND channel = 'whatsapp' AND provider = 'evolution'
            AND owner_user_id = $2
          LIMIT 1`,
        [orgId, ownerUserId],
      );
      return row ?? null;
    });
  }

  private async upsertChannel(
    orgId: string,
    ownerUserId: string,
    input: {
      id: string | null;
      phone: string;
      displayName: string | null;
      token: string;
      baseUrl: string;
      instanceName: string;
    },
  ): Promise<string> {
    return this.db.withOrg(orgId, async (client) => {
      const config = JSON.stringify({
        evolutionInstance: input.instanceName,
        linkedVia: "pairing",
      });

      if (input.id) {
        const {
          rows: [updated],
        } = await client.query<{ id: string }>(
          `UPDATE messaging_channels
              SET inbound_address = $3,
                  display_name = COALESCE($4, display_name),
                  api_key = $5,
                  api_base_url = $6,
                  config = config || $7::jsonb,
                  status = 'active',
                  updated_at = now()
            WHERE id = $1 AND org_id = $2 AND owner_user_id = $8
          RETURNING id`,
          [
            input.id,
            orgId,
            input.phone,
            input.displayName,
            encryptSecret(input.token),
            input.baseUrl,
            config,
            ownerUserId,
          ],
        );
        return updated.id;
      }

      try {
        const {
          rows: [created],
        } = await client.query<{ id: string }>(
          `INSERT INTO messaging_channels
             (org_id, channel, provider, inbound_address, display_name,
              api_key, api_base_url, config, webhook_token, owner_user_id)
           VALUES ($1, 'whatsapp', 'evolution', $2, $3, $4, $5, $6::jsonb, $7, $8)
           RETURNING id`,
          [
            orgId,
            input.phone,
            input.displayName,
            encryptSecret(input.token),
            input.baseUrl,
            config,
            newToken(),
            ownerUserId,
          ],
        );
        return created.id;
      } catch (err) {
        // Same non-disclosure as the channels controller: the address is
        // UNIQUE platform-wide, and confirming that a number is registered to
        // somebody else is itself a disclosure.
        if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
          throw new ConflictException("that number is already registered");
        }
        throw err;
      }
    });
  }

  private async webhookTokenFor(orgId: string, channelId: string): Promise<string> {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{ webhook_token: string }>(
        `SELECT webhook_token FROM messaging_channels WHERE id = $1 AND org_id = $2`,
        [channelId, orgId],
      );
      return row.webhook_token;
    });
  }

  private async markLinked(orgId: string, channelId: string, name: string | null): Promise<void> {
    await this.db.withOrg(orgId, (client) =>
      client.query(
        `UPDATE messaging_channels
            SET status = 'active',
                display_name = COALESCE(display_name, $3),
                config = config || jsonb_build_object('linkedAt', now()::text),
                updated_at = now()
          WHERE id = $1 AND org_id = $2`,
        [channelId, orgId, name],
      ),
    );
  }

  /**
   * Where Evolution should deliver.
   *
   * ── THE API DOES NOT KNOW ITS OWN PUBLIC HOSTNAME ───────────────────────
   *
   * Behind Caddy it answers on `api:4000` inside the compose network and on
   * `https://<APP_DOMAIN>/v1` from the internet, and only the deployment's env
   * knows which. The same problem `apps/web/lib/public-origin.ts` solves for
   * the lead-intake webhook, resolved the same way and in the same order so
   * the two cannot disagree about what this deployment's public origin is.
   *
   * It matters more here than there. In the Wasi flow an admin PASTES the URL
   * into another console and sees it; this one is handed to a third party
   * programmatically, so a wrong origin fails silently - the number links, the
   * console says connected, and no message ever arrives. Hence the hard
   * refusal rather than a localhost default: a pairing that cannot receive is
   * worse than a pairing that did not happen.
   */
  private webhookUrl(webhookToken: string): string {
    const explicit = process.env.INTAKE_PUBLIC_URL?.trim();
    const domain = process.env.APP_DOMAIN?.trim();
    const base = explicit || (domain ? `https://${domain}` : process.env.API_URL?.trim());
    if (!base) {
      throw new ServiceUnavailableException(
        "this deployment does not know its own public URL (set APP_DOMAIN, or INTAKE_PUBLIC_URL), " +
          "so the WhatsApp relay has nowhere to deliver messages",
      );
    }
    return `${base.replace(/\/+$/, "")}/v1/messaging/webhook/${webhookToken}`;
  }
}

interface PersonalChannelRow {
  id: string;
  inbound_address: string;
  api_key: string | null;
  api_base_url: string | null;
  config: { evolutionInstance?: string } | null;
  status: "active" | "disabled";
}

/**
 * The signed-in person this request acts for. A caller with no seat of its
 * own - the bare admin key, the operator console - has no phone to link, and
 * would otherwise create a channel that belongs to nobody and whose chats
 * nobody could ever read.
 */
function requirePerson(req: PrincipalRequest): string {
  const me = threadViewerOf(req);
  if (!me) {
    throw new ForbiddenException(
      "linking a WhatsApp number needs a signed-in person - it becomes that person's own number",
    );
  }
  return me;
}

/** 32 bytes of CSPRNG. Same rule as the webhook token: never derived. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}
