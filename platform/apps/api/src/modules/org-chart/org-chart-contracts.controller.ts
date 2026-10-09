import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  ContractDocumentInput,
  ContractInput,
  ORG_CHART_DEFAULTS,
  UpdateContractInput,
  deriveContractStatus,
  redactContract,
  reminderOffsetFor,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { S3Service } from "../../s3/s3.service";
import { logOrgChange, orgToday, requireMember } from "./tree";

/**
 * Employment contracts and their documents - the restricted half of the org
 * chart (Build docs/org-chart-build-plan.md §6.3, §7, milestone M7).
 *
 * ── THE ONE THING THIS FILE EXISTS TO GUARANTEE ────────────────────────────
 *
 * M7's acceptance criterion: "a telecaller cannot retrieve any contract data
 * (verified by API tests)".
 *
 * That is true BEFORE any handler here runs. 0178 seeds
 * `employment_contract:*` to the three admin roles and to nobody else, and
 * `CrmPermissionsGuard` denies whatever it finds no grant for - so a
 * telecaller gets a 403, not a redacted payload and not an empty list. The
 * redaction below is the SECOND layer, for the case §6.3 actually describes: a
 * reader who may see the contract's terms but not its figures.
 *
 * ── WHY `owned` SCOPE IS HONOURED HERE AND NOWHERE ELSE IN THIS MODULE ─────
 *
 * `employment_contract` is the one object in this module with a real owner
 * column (`user_id`, wired in crm-scope.ts). An org that wants people to read
 * their OWN contract grants `view` at `owned` scope, and `@RecordScope()` then
 * narrows every read below by a WHERE clause rather than by a UI. 0178 does
 * not seed that - §7's default is that staff see nothing - but the mechanism
 * is real rather than decorative, which is why the scope is applied on the
 * list, the read AND the document routes. A scope honoured on the list and
 * forgotten on `GET /documents/:id/url` is a scope that does nothing.
 */

const ListQuery = z.object({
  userId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  status: z.enum(["draft", "active", "ended"]).optional(),
  /** §10's pipeline view: contracts inside the widest §14 window. */
  expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});

@Controller("org-chart/contracts")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class OrgChartContractsController {
  constructor(
    private readonly db: DbService,
    private readonly s3: S3Service,
  ) {}

  @Get()
  @RequireCrmPermission("employment_contract", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace("$?", `$${params.length}`));
      };

      if (q.userId) add("c.user_id = $?", q.userId);
      if (q.positionId) add("c.position_id = $?", q.positionId);
      if (q.status) add("c.status = $?", q.status);
      if (q.expiringWithinDays) {
        add("c.end_date IS NOT NULL AND c.end_date <= ($?::date)", shiftDays(today, q.expiringWithinDays));
        where.push("c.status = 'active'");
      }
      // The `owned` narrowing. `scopeFilter` is not used because this is the
      // only table in the module with an owner column and the clause is one
      // comparison - but the COLUMN is the one crm-scope.ts names, so the
      // console's grid and this query cannot disagree about what `owned` means.
      if (recordScope.scope === "owned" && recordScope.userId) {
        add("c.user_id = $?", recordScope.userId);
      }

      const { rows } = await client.query<ContractRow>(
        `SELECT ${CONTRACT_COLUMNS}
           FROM employment_contracts c
           JOIN users u ON u.id = c.user_id
           LEFT JOIN positions p ON p.id = c.position_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY c.status, c.end_date NULLS LAST, u.name`,
        params,
      );

      const visibility = "full" as const;
      return {
        today,
        contracts: rows.map((row) => shapeContract(row, today, visibility)),
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("employment_contract", "view")
  async one(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const { rows } = await client.query<ContractRow>(
        `SELECT ${CONTRACT_COLUMNS}
           FROM employment_contracts c
           JOIN users u ON u.id = c.user_id
           LEFT JOIN positions p ON p.id = c.position_id
          WHERE c.id = $1`,
        [id],
      );
      const row = rows[0];
      /**
       * 404 rather than 403 when a scoped reader asks for somebody else's.
       *
       * §7's "a telecaller must never read another person's contract, even by
       * guessing an ID" - and a 403 here would confirm the id EXISTS, which
       * for a table of one row per employee is the difference between guessing
       * an id and learning that a colleague has a contract on file. The
       * indistinguishable answer is the correct one.
       */
      if (!row) throw new NotFoundException("That contract does not exist.");
      if (recordScope.scope === "owned" && row.user_id !== recordScope.userId) {
        throw new NotFoundException("That contract does not exist.");
      }

      const documents = await client.query<{
        id: string;
        doc_type: string;
        file_name: string;
        content_type: string;
        bytes: string;
        version: number;
        signed_at: string | null;
        created_at: string;
        uploaded_by_name: string | null;
      }>(
        `SELECT d.id::text AS id, d.doc_type, d.file_name, d.content_type, d.bytes::text AS bytes,
                d.version, d.signed_at::text AS signed_at, d.created_at::text AS created_at,
                u.name AS uploaded_by_name
           FROM contract_documents d
           LEFT JOIN users u ON u.id = d.uploaded_by
          WHERE d.contract_id = $1
          ORDER BY d.doc_type, d.version DESC`,
        [id],
      );

      /**
       * §7's third MUST: "Log every view and download of a contract document".
       *
       * Logged on the LIST too, not only on the signed URL. Reading the list
       * tells somebody what paperwork exists for a colleague, which is itself
       * a disclosure - and an access log that only records downloads cannot
       * answer "who has been looking at Priya's file".
       *
       * Skipped entirely when there are no documents: a row saying somebody
       * listed an empty folder is noise in the one log that must stay readable.
       */
      if (documents.rowCount && documents.rowCount > 0) {
        await client.query(
          `INSERT INTO document_access_log (org_id, document_id, contract_id, actor_type, actor_id, action, ip)
           VALUES ($1, $2, $3, $4, $5, 'list', $6)`,
          [orgId, id, id, actor.type, actor.id, req.ip ?? null],
        );
      }

      return {
        today,
        contract: shapeContract(row, today, "full"),
        documents: documents.rows.map((d) => ({
          id: d.id,
          docType: d.doc_type,
          fileName: d.file_name,
          contentType: d.content_type,
          bytes: Number(d.bytes),
          version: d.version,
          signedAt: d.signed_at,
          uploadedAt: d.created_at,
          uploadedByName: d.uploaded_by_name,
        })),
      };
    });
  }

  @Post()
  @RequireCrmPermission("employment_contract", "create")
  async create(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = ContractInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      await requireMember(client, input.userId);
      assertDatesCoherent(input);

      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO employment_contracts
             (org_id, user_id, position_id, employment_type, start_date, end_date, renewal_date,
              probation_end_date, notice_period_days, comp_structure, comp_fixed_num,
              comp_currency, status, notes)
           VALUES ($1, $2, $3, $4, $5::date, $6::date, $7::date, $8::date, $9, $10, $11, $12,
                   COALESCE($13, 'draft'), $14)
           RETURNING id::text AS id`,
          [
            orgId,
            input.userId,
            input.positionId ?? null,
            input.employmentType,
            input.startDate,
            input.endDate ?? null,
            input.renewalDate ?? null,
            input.probationEndDate ?? null,
            input.noticePeriodDays ?? null,
            input.compStructure ?? null,
            input.compFixedNum ?? null,
            input.compCurrency ?? null,
            input.status ?? null,
            input.notes ?? null,
          ],
        );
        await logOrgChange(client, orgId, actor, {
          entity: "contract",
          entityId: rows[0].id,
          action: "create",
          /**
           * The log entry carries the TERMS and never the figure.
           *
           * `org_change_log` is read by §6.5's History tab, which is gated on
           * `position:view` - every persona. Putting `comp_fixed_num` in
           * `after` would publish every salary to the whole floor through a
           * timeline nobody thinks of as a contract screen. This is the one
           * place in the module where a redaction has to happen on a WRITE.
           */
          after: {
            userId: input.userId,
            employmentType: input.employmentType,
            startDate: input.startDate,
            status: input.status ?? "draft",
          },
          effectiveDate: input.startDate,
        });
        return { id: rows[0].id };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(
            "That person already has an active contract. End it, or edit it instead of adding a second.",
          );
        }
        throw err;
      }
    });
  }

  @Patch(":id")
  @RequireCrmPermission("employment_contract", "edit")
  async update(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = UpdateContractInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const before = await client.query<{
        employment_type: string;
        start_date: string;
        end_date: string | null;
        probation_end_date: string | null;
        status: string;
      }>(
        `SELECT employment_type, start_date::text AS start_date, end_date::text AS end_date,
                probation_end_date::text AS probation_end_date, status
           FROM employment_contracts WHERE id = $1`,
        [id],
      );
      if (!before.rows[0]) throw new NotFoundException("That contract does not exist.");

      assertDatesCoherent({
        startDate: input.startDate ?? before.rows[0].start_date,
        endDate: input.endDate === undefined ? before.rows[0].end_date : input.endDate,
        probationEndDate:
          input.probationEndDate === undefined
            ? before.rows[0].probation_end_date
            : input.probationEndDate,
      });

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown, cast = "") => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      };
      if (input.positionId !== undefined) set("position_id", input.positionId);
      if (input.employmentType !== undefined) set("employment_type", input.employmentType);
      if (input.startDate !== undefined) set("start_date", input.startDate, "::date");
      if (input.endDate !== undefined) set("end_date", input.endDate, "::date");
      if (input.renewalDate !== undefined) set("renewal_date", input.renewalDate, "::date");
      if (input.probationEndDate !== undefined) {
        set("probation_end_date", input.probationEndDate, "::date");
      }
      if (input.noticePeriodDays !== undefined) set("notice_period_days", input.noticePeriodDays);
      if (input.compStructure !== undefined) set("comp_structure", input.compStructure);
      if (input.compFixedNum !== undefined) set("comp_fixed_num", input.compFixedNum);
      if (input.compCurrency !== undefined) set("comp_currency", input.compCurrency);
      if (input.status !== undefined) set("status", input.status);
      if (input.notes !== undefined) set("notes", input.notes);

      params.push(id);
      try {
        await client.query(
          `UPDATE employment_contracts SET ${sets.join(", ")} WHERE id = $${params.length}`,
          params,
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(
            "That person already has another active contract. End that one first.",
          );
        }
        throw err;
      }

      await logOrgChange(client, orgId, actor, {
        entity: "contract",
        entityId: id,
        action: "update",
        // Terms only, never the figure - see the note on create.
        before: {
          employmentType: before.rows[0].employment_type,
          endDate: before.rows[0].end_date,
          status: before.rows[0].status,
        },
        after: {
          employmentType: input.employmentType,
          endDate: input.endDate,
          status: input.status,
        },
      });
      return { ok: true };
    });
  }

  /**
   * §6.3's document upload, as a presigned PUT.
   *
   * ── WHY THE BYTES NEVER PASS THROUGH THIS API ──────────────────────────────
   *
   * The browser PUTs straight to object storage with a 15-minute signed URL,
   * and this route only records the row. Same shape as branding uploads and
   * the recording pipeline. A multipart POST through Nest would put a 20 MB
   * signed PDF through the API's memory and its request-size limit for no
   * benefit.
   *
   * ── VERSIONS, AND THE RACE THE INDEX CLOSES ────────────────────────────────
   *
   * `version` is `max + 1` per (contract, doc_type), computed in the INSERT
   * itself rather than read and then written. Two uploads racing would both
   * read `max = 2` and both write 3; the unique index
   * `contract_documents_version` refuses the second, and the 23505 is reported
   * as a retryable conflict rather than a 500.
   */
  @Post(":id/documents")
  @RequireCrmPermission("employment_contract", "edit")
  async addDocument(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = ContractDocumentInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    if (!ALLOWED_DOC_TYPES.has(input.contentType)) {
      throw new BadRequestException(
        "Upload a PDF, an image or a Word document. Other file types are not accepted here.",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      const contract = await client.query<{ user_id: string }>(
        "SELECT user_id::text AS user_id FROM employment_contracts WHERE id = $1",
        [id],
      );
      if (!contract.rows[0]) throw new NotFoundException("That contract does not exist.");

      /**
       * The storage key carries the ORG and a random id, and never the file
       * name.
       *
       * The org prefix is what makes a mis-signed URL still tenant-shaped in a
       * bucket listing. The random id is what stops `offer-letter.pdf` from
       * colliding across two contracts, and stops the key from leaking a
       * person's name to anybody who can see a URL - a signed URL is a
       * credential, and it travels through browser history and server logs.
       * The real file name lives in the row and is sent back as
       * Content-Disposition when the document is fetched.
       */
      const key = `org-charts/${orgId}/contracts/${id}/${crypto.randomUUID()}`;

      let documentId: string;
      try {
        const { rows } = await client.query<{ id: string; version: number }>(
          `INSERT INTO contract_documents
             (org_id, contract_id, doc_type, s3_key, file_name, content_type, bytes, version,
              uploaded_by, signed_at)
           SELECT $1, $2, $3, $4, $5, $6, $7,
                  COALESCE(max(d.version), 0) + 1,
                  $8, $9::date
             FROM contract_documents d
            WHERE d.contract_id = $2 AND d.doc_type = $3
           RETURNING id::text AS id, version`,
          [
            orgId,
            id,
            input.docType,
            key,
            input.fileName,
            input.contentType,
            input.bytes,
            actor.type === "user" ? actor.id : null,
            input.signedAt ?? null,
          ],
        );
        documentId = rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException("Somebody uploaded a version at the same moment. Try again.");
        }
        throw err;
      }

      await client.query(
        `INSERT INTO document_access_log (org_id, document_id, contract_id, actor_type, actor_id, action, ip)
         VALUES ($1, $2, $3, $4, $5, 'upload', $6)`,
        [orgId, documentId, id, actor.type, actor.id, req.ip ?? null],
      );
      await logOrgChange(client, orgId, actor, {
        entity: "document",
        entityId: documentId,
        action: "create",
        after: { docType: input.docType, fileName: input.fileName, contractId: id },
      });

      const uploadUrl = await this.s3.presignedPutUrl(key, input.contentType, 900);
      return { id: documentId, uploadUrl, expiresInSeconds: 900 };
    });
  }

  /**
   * §7: "Contract documents are served through short-lived signed URLs, not
   * public links", and every fetch is logged.
   *
   * 300 seconds, not the 1800 the recording player uses. A signed URL IS a
   * credential - anybody holding it reads the document, with no further
   * check - and the two cases differ: a call recording is streamed while
   * somebody listens, so a short expiry breaks playback, whereas a contract is
   * fetched once and opened. Five minutes is long enough for a slow download
   * and short enough that a URL in a chat message or a browser history is dead
   * before it is useful.
   */
  @Get("documents/:documentId/url")
  @RequireCrmPermission("employment_contract", "view")
  async documentUrl(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("documentId", ParseUUIDPipe) documentId: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        contract_id: string;
        s3_key: string;
        content_type: string;
        file_name: string;
        user_id: string;
      }>(
        `SELECT d.id::text AS id, d.contract_id::text AS contract_id, d.s3_key, d.content_type,
                d.file_name, c.user_id::text AS user_id
           FROM contract_documents d
           JOIN employment_contracts c ON c.id = d.contract_id
          WHERE d.id = $1`,
        [documentId],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException("That document does not exist.");
      // The scope applies here too. A scope honoured on the list and forgotten
      // on the route that hands out the file is a scope that does nothing.
      if (recordScope.scope === "owned" && row.user_id !== recordScope.userId) {
        throw new NotFoundException("That document does not exist.");
      }

      await client.query(
        `INSERT INTO document_access_log (org_id, document_id, contract_id, actor_type, actor_id, action, ip)
         VALUES ($1, $2, $3, $4, $5, 'url', $6)`,
        [orgId, row.id, row.contract_id, actor.type, actor.id, req.ip ?? null],
      );

      const url = await this.s3.presignedGetUrl(row.s3_key, 300, row.content_type);
      return { url, fileName: row.file_name, expiresInSeconds: 300 };
    });
  }

  /** §7's MUST: the access trail is readable, by whoever may read the contracts. */
  @Get(":id/access-log")
  @RequireCrmPermission("employment_contract", "view")
  async accessLog(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        action: string;
        actor_type: string;
        actor_id: string;
        actor_name: string | null;
        at: string;
        ip: string | null;
      }>(
        `SELECT l.action, l.actor_type, l.actor_id,
                CASE WHEN l.actor_type = 'user' THEN u.name ELSE l.actor_id END AS actor_name,
                l.at::text AS at, l.ip
           FROM document_access_log l
           LEFT JOIN users u
             ON l.actor_type = 'user'
            AND u.id = CASE WHEN l.actor_type = 'user' THEN l.actor_id::uuid ELSE NULL END
          WHERE l.contract_id = $1
          ORDER BY l.at DESC
          LIMIT 200`,
        [id],
      );
      return { entries: rows };
    });
  }

  /**
   * §10's reminder pipeline, as a read.
   *
   * The console's Contracts tab shows what is coming up; the WORKER raises the
   * notifications. Two readers of the same rule, so the offsets come from
   * `reminderOffsetFor` in both rather than from a date predicate written
   * twice - a banner that says "expiring" a fortnight before anybody is told
   * is the drift this avoids.
   */
  @Get("reminders/upcoming")
  @RequireCrmPermission("employment_contract", "view")
  async upcoming(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const { rows } = await client.query<{
        id: string;
        user_id: string;
        user_name: string | null;
        position_title: string | null;
        end_date: string | null;
        probation_end_date: string | null;
      }>(
        `SELECT c.id::text AS id, c.user_id::text AS user_id, u.name AS user_name,
                p.title AS position_title,
                c.end_date::text AS end_date, c.probation_end_date::text AS probation_end_date
           FROM employment_contracts c
           JOIN users u ON u.id = c.user_id
           LEFT JOIN positions p ON p.id = c.position_id
          WHERE c.status = 'active'
            AND (c.end_date IS NOT NULL OR c.probation_end_date IS NOT NULL)
          ORDER BY LEAST(COALESCE(c.end_date, 'infinity'::date),
                         COALESCE(c.probation_end_date, 'infinity'::date))`,
      );

      return {
        today,
        expiring: rows
          .map((r) => ({
            contractId: r.id,
            userId: r.user_id,
            userName: r.user_name,
            positionTitle: r.position_title,
            endDate: r.end_date,
            offsetDays: reminderOffsetFor(today, r.end_date, ORG_CHART_DEFAULTS.contractExpiryDays),
          }))
          .filter((r) => r.offsetDays !== null),
        probationEnding: rows
          .map((r) => ({
            contractId: r.id,
            userId: r.user_id,
            userName: r.user_name,
            positionTitle: r.position_title,
            probationEndDate: r.probation_end_date,
            offsetDays: reminderOffsetFor(
              today,
              r.probation_end_date,
              ORG_CHART_DEFAULTS.probationEndDays,
            ),
          }))
          .filter((r) => r.offsetDays !== null),
      };
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Shared shaping
// ───────────────────────────────────────────────────────────────────────────

const CONTRACT_COLUMNS = `
  c.id::text AS id, c.user_id::text AS user_id, u.name AS user_name, u.email AS user_email,
  c.position_id::text AS position_id, p.title AS position_title,
  c.employment_type, c.start_date::text AS start_date, c.end_date::text AS end_date,
  c.renewal_date::text AS renewal_date, c.probation_end_date::text AS probation_end_date,
  c.notice_period_days, c.comp_structure, c.comp_fixed_num::text AS comp_fixed_num,
  c.comp_currency, c.status, c.notes`;

interface ContractRow {
  id: string;
  user_id: string;
  user_name: string | null;
  user_email: string;
  position_id: string | null;
  position_title: string | null;
  employment_type: string;
  start_date: string;
  end_date: string | null;
  renewal_date: string | null;
  probation_end_date: string | null;
  notice_period_days: number | null;
  comp_structure: string | null;
  comp_fixed_num: string | null;
  comp_currency: string | null;
  status: "draft" | "active" | "ended";
  notes: string | null;
}

/**
 * One row to one payload, with `status` derived and the figures redacted.
 *
 * `redactContract` is applied here rather than in each route so there is ONE
 * place a compensation figure can leave this module. §7's MUST is "redact
 * sensitive fields in API responses for unauthorized roles (not just in the
 * UI)", and a redaction applied per-route is a redaction somebody forgets on
 * the fourth route.
 *
 * `visibility` is `full` for every caller today, because 0178 grants
 * `employment_contract:view` to admin roles only and §6.3 gives those readers
 * the amounts. The `terms` level exists and is wired so that the moment an org
 * grants the object to a manager - which the grid allows - the figures stop
 * being sent, rather than that being a change somebody has to remember to make
 * in the API at the same time.
 */
function shapeContract(
  row: ContractRow,
  today: string,
  visibility: "full" | "terms",
): Record<string, unknown> | null {
  return redactContract(
    {
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      userEmail: row.user_email,
      positionId: row.position_id,
      positionTitle: row.position_title,
      employmentType: row.employment_type,
      startDate: row.start_date,
      endDate: row.end_date,
      renewalDate: row.renewal_date,
      probationEndDate: row.probation_end_date,
      noticePeriodDays: row.notice_period_days,
      storedStatus: row.status,
      status: deriveContractStatus(row.status, row.end_date, today),
      compStructure: (row.comp_structure as "fixed" | "fixed_plus_incentive" | "commission") ?? null,
      compFixedNum: row.comp_fixed_num === null ? null : Number(row.comp_fixed_num),
      compCurrency: row.comp_currency,
      notes: row.notes,
    },
    visibility,
  );
}

/**
 * The date relationships no CHECK constraint can express across three columns
 * without becoming unreadable.
 *
 * 0178 enforces `end_date >= start_date`. This adds the probation rule, which
 * matters because a probation end BEFORE the start date produces a contract
 * that is permanently "probation ending in -40 days" - and the sweep would
 * either notify forever or never, depending on which side of the comparison
 * it landed on.
 */
function assertDatesCoherent(input: {
  startDate: string;
  endDate?: string | null;
  probationEndDate?: string | null;
}): void {
  if (input.endDate && input.endDate < input.startDate) {
    throw new BadRequestException("The contract cannot end before it starts.");
  }
  if (input.probationEndDate && input.probationEndDate < input.startDate) {
    throw new BadRequestException("Probation cannot end before the contract starts.");
  }
  if (input.endDate && input.probationEndDate && input.probationEndDate > input.endDate) {
    throw new BadRequestException("Probation cannot end after the contract does.");
  }
}

/**
 * The content types a contract document may be.
 *
 * An allowlist, not a denylist. `content_type` is echoed back as the
 * `ResponseContentType` of a signed GET, so an attacker-chosen value is a
 * value the browser is told to interpret - `text/html` would make the bucket
 * serve a script from a URL the console hands out, and the same-origin rules
 * that normally contain that do not apply to an object-storage host shared by
 * every tenant.
 */
const ALLOWED_DOC_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/** `YYYY-MM-DD` plus n days, for the expiring-within filter. */
function shiftDays(from: string, days: number): string {
  const [y, m, d] = from.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
