import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { CONNECTORS, connectorFor, decryptSecret, encryptSecret } from "@aura/db";
import { FINANCE_DEFAULTS } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * §7.5's connector UI, server side: connect, health, failed events, replay.
 *
 * ── CREDENTIALS ARE OWNER-ONLY, AND NEVER RETURNED ──────────────────────────
 *
 * §3 gives the finance handler everything "(no connector secrets)". A grid
 * cell is the wrong shape for "nobody but the owner, ever" - it can be ticked
 * - so the two routes that touch a secret carry `OwnerRoleGuard` and
 * `@RequireOwnerRole("owner")` on top of the grid.
 *
 * §7.2.8: "never returned by any API". `CONNECTOR_COLUMNS` below omits
 * `credentials_enc` and there is no route that reads it into a response. What
 * the health page gets instead is `hasCredentials` - a boolean - which answers
 * the only question a screen needs to ask.
 *
 * ── THE WEBHOOK IS A SEPARATE CONTROLLER ────────────────────────────────────
 *
 * `FinanceWebhookController` below carries NO guards: a gateway cannot present
 * an admin key. Its authentication IS the signature, verified against the
 * account named in its own path before the body is parsed (§7.2.1). That is
 * the same arrangement `razorpay-webhook.controller.ts` (0060) already has,
 * and the reason both are in the unguarded class of
 * `guard-mounting.spec.ts`'s census rather than looking like an oversight.
 */

const CONNECTOR_COLUMNS = `c.id, c.type, c.label, c.status, c.config,
  c.last_event_at, c.last_error, c.consecutive_failures, c.token_expires_at,
  to_char(c.reconciled_through, 'YYYY-MM-DD') AS reconciled_through,
  c.created_at, c.updated_at,
  -- A BOOLEAN, never the secret. §7.2.8.
  (c.credentials_enc ? 'keyId') AS has_credentials`;

interface ConnectorRow {
  id: string;
  type: string;
  label: string;
  status: string;
  config: Record<string, unknown>;
  last_event_at: Date | null;
  last_error: string | null;
  consecutive_failures: number;
  token_expires_at: Date | null;
  reconciled_through: string | null;
  created_at: Date;
  updated_at: Date;
  has_credentials: boolean;
  queue_depth?: string;
  failed_events?: string;
}

function presentConnector(row: ConnectorRow) {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    status: row.status,
    config: row.config,
    hasCredentials: row.has_credentials,
    /** §7.5's health page, in the five figures it actually shows. */
    health: {
      lastEventAt: row.last_event_at,
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
      tokenExpiresAt: row.token_expires_at,
      reconciledThrough: row.reconciled_through,
      queueDepth: Number(row.queue_depth ?? 0),
      failedEvents: Number(row.failed_events ?? 0),
      /**
       * §12.4's `connector_unhealthy` test, computed for the screen so the
       * badge and the alert cannot disagree: no events for a day, or five
       * failures in a row.
       */
      healthy:
        row.status === "connected" &&
        row.consecutive_failures < 5 &&
        row.last_event_at !== null &&
        Date.now() - row.last_event_at.getTime() < 24 * 3600 * 1000,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const AUDIT_SQL = `INSERT INTO audit_log
   (org_id, actor_type, actor_id, action, target_type, target_id, meta)
 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;

@Controller("finance/connectors")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ConnectorsController {
  constructor(private readonly db: DbService) {}

  /** §7.5: the catalogue of what can be connected. */
  @Get("available")
  @RequireCrmPermission("finance", "view")
  available() {
    return {
      connectors: Object.values(CONNECTORS).map((c) => ({ type: c.type, label: c.label })),
    };
  }

  @Get()
  @RequireCrmPermission("finance", "view")
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<ConnectorRow>(
        `SELECT ${CONNECTOR_COLUMNS},
                (SELECT count(*) FROM connector_events e
                  WHERE e.connector_account_id = c.id
                    AND e.processed_at IS NULL
                    AND e.attempts < $1)::text AS queue_depth,
                (SELECT count(*) FROM connector_events e
                  WHERE e.connector_account_id = c.id
                    AND e.processed_at IS NULL
                    AND e.attempts >= $1)::text AS failed_events
           FROM connector_accounts c
          ORDER BY c.type, lower(c.label)`,
        [FINANCE_DEFAULTS.maxEventAttempts],
      );
      return { connectors: rows.map(presentConnector) };
    });
  }

  /**
   * Connect or re-authenticate. OWNER ONLY - this is the route a secret
   * arrives on.
   *
   * ── THE KEYS ARE VALIDATED BEFORE THEY ARE STORED ──────────────────────────
   *
   * A connector saved with a bad key looks connected and silently delivers
   * nothing, which is the worst of the available outcomes: the health page
   * says "connected", no events arrive, and nobody finds out until a month's
   * collections are missing. So the credentials are tried against the gateway
   * first and a failure is a 400 with the gateway's own reason.
   */
  @Post()
  @UseGuards(OwnerRoleGuard)
  @RequireOwnerRole("owner")
  @RequireCrmPermission("finance", "create")
  async connect(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = z
      .object({
        type: z.string().trim().min(1).max(60),
        label: z.string().trim().min(1).max(120),
        keyId: z.string().trim().min(1).max(200),
        keySecret: z.string().trim().min(1).max(500),
        webhookSecret: z.string().trim().max(500).optional(),
        config: z.record(z.string(), z.unknown()).default({}),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    const connector = connectorFor(input.type);
    if (!connector) throw new BadRequestException(`no connector for "${input.type}"`);

    const check = await connector.validateCredentials({
      keyId: input.keyId,
      keySecret: input.keySecret,
      webhookSecret: input.webhookSecret ?? null,
    });
    if (!check.ok) {
      throw new BadRequestException(check.detail ?? "those credentials did not work");
    }

    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      // Sealed with the same AES-256-GCM envelope the CRM integrations and org
      // OAuth apps use. The whole credential set goes in one JSONB value so a
      // connector needing a third field later does not need a column.
      const sealed = {
        keyId: encryptSecret(input.keyId),
        keySecret: encryptSecret(input.keySecret),
        webhookSecret: input.webhookSecret ? encryptSecret(input.webhookSecret) : null,
      };

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO connector_accounts
           (org_id, type, label, credentials_enc, config, status, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'connected', $6)
         ON CONFLICT (org_id, type, lower(label))
         DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc,
                       config = connector_accounts.config || EXCLUDED.config,
                       status = 'connected',
                       -- A re-authentication clears the failure history: the
                       -- old key's errors say nothing about the new one, and
                       -- leaving them would keep connector_unhealthy firing.
                       consecutive_failures = 0,
                       last_error = NULL
         RETURNING id`,
        [
          orgId,
          input.type,
          input.label,
          JSON.stringify(sealed),
          JSON.stringify(input.config),
          actor.type === "user" ? actor.id : null,
        ],
      );

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.connector.connected",
        "connector_account",
        rows[0].id,
        // The TYPE and the LABEL, never a key fragment. An audit row is a
        // place secrets leak from as surely as a response body.
        JSON.stringify({ type: input.type, label: input.label }),
      ]);

      return {
        id: rows[0].id,
        /** The URL to paste into the gateway's own webhook settings. */
        webhookPath: `/v1/finance/webhooks/${rows[0].id}`,
      };
    });
  }

  /**
   * Disconnect. OWNER ONLY, and it does NOT delete the account.
   *
   * `status = 'disconnected'` and the credentials cleared. Deleting the row
   * would CASCADE `connector_events` - the raw store §7.2.5's replay depends
   * on - and SET NULL every payment's `connector_account_id`, so the gateway a
   * year of money came through would become unknowable. A disconnected account
   * stops ingesting and keeps its history.
   */
  @Post(":id/disconnect")
  @UseGuards(OwnerRoleGuard)
  @RequireOwnerRole("owner")
  @RequireCrmPermission("finance", "create")
  async disconnect(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE connector_accounts
            SET status = 'disconnected', credentials_enc = '{}'::jsonb
          WHERE id = $1`,
        [id],
      );
      if (!rowCount) throw new NotFoundException("connector not found");
      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.connector.disconnected",
        "connector_account",
        id,
        "{}",
      ]);
      return { id, status: "disconnected" };
    });
  }

  /** §7.5's failed-event list. */
  @Get(":id/events")
  @RequireCrmPermission("finance", "view")
  async events(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    const parsed = z
      .object({
        failedOnly: z.enum(["1", "true"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        external_id: string;
        event_type: string | null;
        signature_ok: boolean;
        received_at: Date;
        processed_at: Date | null;
        attempts: number;
        error: string | null;
        delivery: string;
      }>(
        `SELECT id, external_id, event_type, signature_ok, received_at,
                processed_at, attempts, error, delivery
           FROM connector_events
          WHERE connector_account_id = $1
            ${parsed.data.failedOnly ? "AND processed_at IS NULL AND error IS NOT NULL" : ""}
          ORDER BY received_at DESC
          LIMIT $2`,
        [id, parsed.data.limit],
      );
      return {
        events: rows.map((r) => ({
          id: r.id,
          externalId: r.external_id,
          eventType: r.event_type,
          signatureOk: r.signature_ok,
          receivedAt: r.received_at,
          processedAt: r.processed_at,
          attempts: r.attempts,
          error: r.error,
          delivery: r.delivery,
          /**
           * `attempts >= max` with nothing processed IS the dead letter
           * (§7.2.4) - published so the screen can label it rather than
           * inferring it from two columns.
           */
          deadLettered: r.processed_at === null && r.attempts >= FINANCE_DEFAULTS.maxEventAttempts,
        })),
        maxAttempts: FINANCE_DEFAULTS.maxEventAttempts,
      };
    });
  }

  /**
   * §7.2.4/§7.2.5: replay stored events.
   *
   * ── A REPLAY IS AN UPDATE, NOT A RE-FETCH ──────────────────────────────────
   *
   * Clearing `processed_at` and `attempts` puts the row back in the sweep's
   * queue, and the normalizer runs again over the SAME stored bytes. That is
   * what makes the whole design work after a mapper bug: fix the mapper, ship
   * it, replay the window. Re-fetching from the gateway would reach a
   * retention limit and would not help for events the gateway no longer lists.
   *
   * Every insert the normalizer makes is keyed on the gateway's own id, so a
   * replay of an event that DID succeed is harmless - the conflict clause
   * absorbs it. That is why this is safe to offer as a button.
   */
  @Post(":id/replay")
  @HttpCode(202)
  @RequireCrmPermission("finance", "create")
  async replay(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({
        /** One event, or everything failed, or a date window. */
        eventId: z.string().uuid().optional(),
        failedOnly: z.boolean().default(true),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const where = ["connector_account_id = $1", "signature_ok"];
      const params: unknown[] = [id];
      if (input.eventId) {
        params.push(input.eventId);
        where.push(`id = $${params.length}`);
      } else if (input.failedOnly) {
        where.push("processed_at IS NULL");
      }
      if (input.from) {
        params.push(input.from);
        where.push(`received_at::date >= $${params.length}::date`);
      }
      if (input.to) {
        params.push(input.to);
        where.push(`received_at::date <= $${params.length}::date`);
      }

      const { rowCount } = await client.query(
        `UPDATE connector_events
            SET processed_at = NULL, attempts = 0, error = NULL,
                next_attempt_at = now(), delivery = 'replay'
          WHERE ${where.join(" AND ")}`,
        params,
      );

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.connector.replayed",
        "connector_account",
        id,
        JSON.stringify({ events: rowCount, ...input }),
      ]);
      // 202, not 200: the rows are queued and the worker's sweep does the work.
      return { queued: rowCount };
    });
  }

  /**
   * §7.5's "test webhook" button.
   *
   * Stores a signed-looking event of its own making with `delivery = 'replay'`
   * and an event type no mapper handles - so it proves the ROUTE, the account
   * lookup and the sweep are alive without inventing a payment. A test that
   * created a real payment would be a test nobody dares press twice.
   */
  @Post(":id/test")
  @RequireCrmPermission("finance", "create")
  async test(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO connector_events
           (org_id, connector_account_id, external_id, event_type, payload,
            headers, signature_ok, delivery)
         VALUES ($1, $2, 'test-' || gen_random_uuid()::text, 'connector.test',
                 jsonb_build_object('event', 'connector.test'), '{}'::jsonb, true, 'replay')
         RETURNING id`,
        [orgId, id],
      );
      return {
        eventId: rows[0].id,
        note: "Queued. It maps to nothing, so it proves the pipeline without creating a payment.",
      };
    });
  }

  /**
   * §7.2.6: run the reconciliation now rather than waiting for the nightly
   * sweep.
   *
   * ── IT RUNS IN THE API, NOT THE WORKER, AND THAT IS A TRADE ────────────────
   *
   * A nightly reconciliation is a worker sweep. This button is the same code
   * called inline, which means a tenant with a long gap can block the request
   * for a while - so the window is capped at 30 days. The honest alternative
   * would be to enqueue it, and that is worth doing the first time somebody
   * needs 90 days; the cap is here so the slow path cannot be reached by
   * accident.
   */
  @Post(":id/reconcile")
  @RequireCrmPermission("finance", "create")
  async reconcile(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({ days: z.number().int().min(1).max(30).default(3) })
      .safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    const { reconcileConnector } = await import("@aura/db");

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        type: string;
        credentials_enc: { keyId?: string; keySecret?: string; webhookSecret?: string | null };
      }>(`SELECT id, type, credentials_enc FROM connector_accounts WHERE id = $1`, [id]);
      const account = rows[0];
      if (!account) throw new NotFoundException("connector not found");
      if (!account.credentials_enc?.keyId || !account.credentials_enc?.keySecret) {
        throw new BadRequestException("this connector has no credentials - reconnect it first");
      }

      const result = await reconcileConnector(
        client,
        orgId,
        {
          id: account.id,
          type: account.type,
          credentials: {
            keyId: decryptSecret(account.credentials_enc.keyId) ?? "",
            keySecret: decryptSecret(account.credentials_enc.keySecret) ?? "",
            webhookSecret: decryptSecret(account.credentials_enc.webhookSecret ?? null),
          },
        },
        parsed.data.days,
      );

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.connector.reconciled",
        "connector_account",
        id,
        JSON.stringify({ days: parsed.data.days, ...result }),
      ]);
      return result;
    });
  }
}
