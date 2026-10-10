import crypto from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
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
  BusinessEntityType,
  ComplianceTag,
  DOCUMENT_CATALOGUE,
  DOCUMENT_GROUP_LABELS,
  DocumentGroup,
  categoriesFor,
  daysUntilExpiry,
  documentExpiryStatus,
  documentUploadProblem,
  vaultGaps,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { parseBody, parseOptionalBody } from "../../common/parse-body";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { S3Service } from "../../s3/s3.service";
import { orgToday } from "./finance-settings";

/**
 * The document vault
 * (Build docs/indian-business-finance-documents-cycles-import §1).
 *
 * ── THE BYTES NEVER PASS THROUGH THIS API ───────────────────────────────────
 *
 * `POST /finance/documents` records a row and returns a 15-minute presigned
 * PUT; the browser uploads straight to object storage. The same shape as
 * contract documents (0178), branding assets and the recording pipeline. A
 * multipart POST through Nest would put a 25 MB scanned deed through the API's
 * memory and its request-size limit for no benefit.
 *
 * It also answers §3's security bullet for this surface in the strongest
 * available way: there is no file for this process to scan, parse or
 * mis-handle, because it never holds one.
 *
 * ── EVERY READ IS LOGGED, TO 0178'S TABLE ───────────────────────────────────
 *
 * `document_access_log` is reused rather than re-created. Its header explains
 * why `document_id` is text and not an FK ("the log must survive the document
 * it records being deleted"), and reusing it means "who read what" is ONE
 * query across the employee store and this one rather than a UNION somebody
 * has to remember to write. A business document's rows leave `contract_id`
 * NULL.
 *
 * A `url` row is the honest record: with a signed URL, viewing and downloading
 * are indistinguishable after the fact, so the row means "this person was
 * handed the means to read this document".
 */

const CategoryCode = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*$/, "A lower-case code with underscores.")
  .max(64);

const CategoryInput = z.object({
  code: CategoryCode,
  label: z.string().trim().min(1).max(200),
  group: DocumentGroup,
  expires: z.boolean().default(false),
  reminderOffsets: z.array(z.number().int().min(1).max(730)).max(8).default([]),
  singleton: z.boolean().default(false),
  ownerUserId: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

/** Written out rather than `.partial()` - see ComplianceController's note. */
const CategoryPatch = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  group: DocumentGroup.optional(),
  expires: z.boolean().optional(),
  reminderOffsets: z.array(z.number().int().min(1).max(730)).max(8).optional(),
  singleton: z.boolean().optional(),
  ownerUserId: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).nullish(),
  archived: z.boolean().optional(),
});

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD.");

const DocumentInput = z.object({
  categoryId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  docNumber: z.string().trim().max(120).nullish(),
  fileName: z.string().trim().min(1).max(300),
  contentType: z.string().trim().min(1).max(200),
  bytes: z.number().int().positive(),
  issuedOn: DateOnly.nullish(),
  expiresOn: DateOnly.nullish(),
  reminderOffsets: z.array(z.number().int().min(1).max(730)).max(8).nullish(),
  ownerUserId: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).nullish(),
  /**
   * The document this one replaces, where it replaces one.
   *
   * §1 wants renewals chased, which means the system has to know that the new
   * insurance policy supersedes the old one - otherwise `document_expired`
   * keeps firing on a policy that was renewed last week. A new version is a
   * new ROW (0180's header), and this is the link.
   */
  supersedesId: z.string().uuid().nullish(),
});

const DocumentPatch = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  docNumber: z.string().trim().max(120).nullish(),
  issuedOn: DateOnly.nullish(),
  expiresOn: DateOnly.nullish(),
  reminderOffsets: z.array(z.number().int().min(1).max(730)).max(8).nullish(),
  ownerUserId: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

interface DocumentRow {
  id: string;
  category_id: string;
  category_code: string;
  category_label: string;
  doc_group: string;
  title: string;
  doc_number: string | null;
  file_name: string;
  content_type: string;
  bytes: string;
  version: number;
  issued_on: string | null;
  expires_on: string | null;
  superseded_at: string | null;
  reminder_offsets: number[] | null;
  category_offsets: number[];
  owner_user_id: string | null;
  owner_name: string | null;
  notes: string | null;
  uploaded_by_name: string | null;
  created_at: string;
}

const DOCUMENT_SELECT = `d.id, d.category_id, c.code AS category_code, c.label AS category_label,
       c.doc_group, d.title, d.doc_number, d.file_name, d.content_type, d.bytes::text AS bytes,
       d.version, d.issued_on::text AS issued_on, d.expires_on::text AS expires_on,
       d.superseded_at::text AS superseded_at, d.reminder_offsets,
       c.reminder_offsets AS category_offsets,
       d.owner_user_id, ow.name AS owner_name, d.notes, up.name AS uploaded_by_name,
       d.created_at::text AS created_at`;

const DOCUMENT_FROM = `FROM business_documents d
       JOIN document_categories c ON c.id = d.category_id
       LEFT JOIN users ow ON ow.id = d.owner_user_id
       LEFT JOIN users up ON up.id = d.uploaded_by`;

@Controller("finance/documents")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class DocumentsController {
  constructor(
    private readonly db: DbService,
    private readonly s3: S3Service,
  ) {}

  // ── Categories ──────────────────────────────────────────────────────────

  @Get("categories")
  @RequireCrmPermission("finance", "view")
  async categories(@OrgId() orgId: string, @Query("includeArchived") includeArchived?: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        code: string;
        label: string;
        doc_group: string;
        expires: boolean;
        reminder_offsets: number[];
        singleton: boolean;
        owner_user_id: string | null;
        owner_name: string | null;
        notes: string | null;
        archived_at: string | null;
        document_count: string;
      }>(
        `SELECT c.id, c.code, c.label, c.doc_group, c.expires, c.reminder_offsets, c.singleton,
                c.owner_user_id, u.name AS owner_name, c.notes, c.archived_at::text AS archived_at,
                (SELECT count(*) FROM business_documents d
                  WHERE d.category_id = c.id AND d.deleted_at IS NULL)::text AS document_count
           FROM document_categories c
           LEFT JOIN users u ON u.id = c.owner_user_id
          WHERE ($1::boolean OR c.archived_at IS NULL)
          ORDER BY c.sort_order, c.label`,
        [includeArchived === "1" || includeArchived === "true"],
      );
      return {
        categories: rows.map((r) => ({
          id: r.id,
          code: r.code,
          label: r.label,
          group: r.doc_group,
          groupLabel: DOCUMENT_GROUP_LABELS[r.doc_group as DocumentGroup] ?? r.doc_group,
          expires: r.expires,
          reminderOffsets: r.reminder_offsets,
          singleton: r.singleton,
          owner: r.owner_user_id ? { id: r.owner_user_id, name: r.owner_name } : null,
          notes: r.notes,
          archivedAt: r.archived_at,
          documentCount: Number(r.document_count),
        })),
      };
    });
  }

  /**
   * Seed the categories §1 lists, filtered to what this business needs.
   *
   * Idempotent on `(org_id, code)`, so a tenant's renamed category survives a
   * later deploy that adds a new one - the same asymmetry the compliance
   * calendar's seed has, and for the same reason.
   */
  @Post("categories/seed")
  @RequireCrmPermission("finance", "edit")
  async seedCategories(@OrgId() orgId: string, @Body() body: unknown) {
    const input = parseOptionalBody(
      z.object({ applicableOnly: z.boolean().default(true) }),
      body,
    );

    return this.db.withOrg(orgId, async (client) => {
      const { rows: profile } = await client.query<{
        entity_type: string | null;
        registrations: string[];
      }>(
        `SELECT entity_type, COALESCE(registrations, '{}') AS registrations
           FROM org_compliance_profile WHERE org_id = $1`,
        [orgId],
      );
      const business = {
        entityType: (profile[0]?.entity_type ?? null) as BusinessEntityType | null,
        tags: (profile[0]?.registrations ?? []) as ComplianceTag[],
      };

      const wanted = input.applicableOnly ? categoriesFor(business) : [...DOCUMENT_CATALOGUE];
      let inserted = 0;
      let order = 0;
      for (const spec of wanted) {
        order += 1;
        const { rowCount } = await client.query(
          `INSERT INTO document_categories
             (org_id, code, label, doc_group, expires, reminder_offsets, singleton, notes, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6::int[], $7, $8, $9)
           ON CONFLICT (org_id, code) DO NOTHING`,
          [
            orgId,
            spec.code,
            spec.label,
            spec.group,
            spec.expires,
            spec.reminderOffsets,
            spec.singleton,
            spec.notes,
            order,
          ],
        );
        inserted += rowCount ?? 0;
      }
      return { inserted, considered: wanted.length };
    });
  }

  @Post("categories")
  @RequireCrmPermission("finance", "edit")
  async createCategory(@OrgId() orgId: string, @Body() body: unknown) {
    const input = parseBody(CategoryInput, body);
    // A category that expires with no offsets never reminds, which makes the
    // expiry field decorative - the exact failure mode this module keeps
    // designing against.
    if (input.expires && input.reminderOffsets.length === 0) {
      throw new BadRequestException(
        "Give this category at least one reminder, or it will never warn you before an expiry.",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO document_categories
           (org_id, code, label, doc_group, expires, reminder_offsets, singleton,
            owner_user_id, notes, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6::int[], $7, $8, $9,
                 COALESCE((SELECT max(sort_order) + 1 FROM document_categories), 1))
         ON CONFLICT (org_id, code) DO NOTHING
         RETURNING id`,
        [
          orgId,
          input.code,
          input.label,
          input.group,
          input.expires,
          input.reminderOffsets,
          input.singleton,
          input.ownerUserId ?? null,
          input.notes ?? null,
        ],
      );
      if (rows.length === 0) {
        throw new BadRequestException(`There is already a category with the code "${input.code}".`);
      }
      return { id: rows[0].id };
    });
  }

  @Patch("categories/:id")
  @RequireCrmPermission("finance", "edit")
  async patchCategory(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parseOptionalBody(CategoryPatch, body);
    if (Object.keys(input).length === 0) throw new BadRequestException("Nothing to change.");

    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE document_categories c SET
           label = COALESCE($2, c.label),
           doc_group = COALESCE($3, c.doc_group),
           expires = COALESCE($4, c.expires),
           reminder_offsets = COALESCE($5::int[], c.reminder_offsets),
           singleton = COALESCE($6, c.singleton),
           owner_user_id = CASE WHEN $7::boolean THEN $8 ELSE c.owner_user_id END,
           notes = CASE WHEN $9::boolean THEN $10 ELSE c.notes END,
           archived_at = CASE WHEN $11::boolean IS NULL THEN c.archived_at
                              WHEN $11::boolean THEN COALESCE(c.archived_at, now())
                              ELSE NULL END
         WHERE c.id = $1`,
        [
          id,
          input.label ?? null,
          input.group ?? null,
          input.expires ?? null,
          input.reminderOffsets ?? null,
          input.singleton ?? null,
          "ownerUserId" in input,
          input.ownerUserId ?? null,
          "notes" in input,
          input.notes ?? null,
          input.archived ?? null,
        ],
      );
      if (rowCount === 0) throw new NotFoundException("No such category.");
      return { ok: true };
    });
  }

  // ── The documents ───────────────────────────────────────────────────────

  @Get()
  @RequireCrmPermission("finance", "view")
  async list(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Query("categoryId") categoryId?: string,
    @Query("group") group?: string,
    @Query("status") status?: string,
    @Query("includeSuperseded") includeSuperseded?: string,
  ) {
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const { rows } = await client.query<DocumentRow>(
        `SELECT ${DOCUMENT_SELECT}
           ${DOCUMENT_FROM}
          WHERE d.deleted_at IS NULL
            AND ($1::boolean OR d.superseded_at IS NULL)
            AND ($2::uuid IS NULL OR d.category_id = $2)
            AND ($3::text IS NULL OR c.doc_group = $3)
          ORDER BY c.sort_order, c.label, d.version DESC, d.created_at DESC`,
        [
          includeSuperseded === "1" || includeSuperseded === "true",
          isUuid(categoryId) ? categoryId : null,
          group ?? null,
        ],
      );

      // Logged on the LIST too, not only on the signed URL - 0178's reasoning:
      // reading the list is reading which documents exist and when they
      // expire, which is itself worth recording.
      await client.query(
        `INSERT INTO document_access_log (org_id, document_id, actor_type, actor_id, action, ip)
         VALUES ($1, 'list', $2, $3, 'list', $4)`,
        [orgId, actor.type, actor.id, req.ip ?? null],
      );

      const documents = rows.map((row) => presentDocument(row, today));
      const wanted = status?.trim();
      return {
        documents: wanted ? documents.filter((d) => d.expiryStatus === wanted) : documents,
        today,
        counts: {
          expired: documents.filter((d) => d.expiryStatus === "expired").length,
          expiring: documents.filter((d) => d.expiryStatus === "expiring").length,
          valid: documents.filter((d) => d.expiryStatus === "valid").length,
          noExpiry: documents.filter((d) => d.expiryStatus === "no_expiry").length,
        },
      };
    });
  }

  /**
   * The singleton categories this business should hold and has not.
   *
   * Only singletons. "No vendor bill this week" is not a gap, and a list that
   * said so would have forty rows nobody can clear - `vaultGaps` has the
   * reasoning and the test.
   */
  @Get("gaps")
  @RequireCrmPermission("finance", "view")
  async gaps(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      // Sequential: one pg client cannot run two queries at once. See the
      // note in compliance.controller.ts's `close` - `Promise.all` over a
      // single client is a correctness bug dressed as a parallelism win.
      const profile = await client.query<{ entity_type: string | null; registrations: string[] }>(
        `SELECT entity_type, COALESCE(registrations, '{}') AS registrations
           FROM org_compliance_profile WHERE org_id = $1`,
        [orgId],
      );
      const held = await client.query<{ code: string }>(
        `SELECT DISTINCT c.code
           FROM business_documents d
           JOIN document_categories c ON c.id = d.category_id
          WHERE d.deleted_at IS NULL AND d.superseded_at IS NULL`,
      );

      const business = {
        entityType: (profile.rows[0]?.entity_type ?? null) as BusinessEntityType | null,
        tags: (profile.rows[0]?.registrations ?? []) as ComplianceTag[],
      };
      const gaps = vaultGaps(business, held.rows.map((r) => r.code));
      return {
        gaps: gaps.map((g) => ({
          ...g,
          groupLabel: DOCUMENT_GROUP_LABELS[g.group] ?? g.group,
        })),
        // Null entity type means nobody has told us what shape of business
        // this is, so the gap list is a guess. The console says so rather than
        // presenting it as complete.
        profileSet: Boolean(profile.rows[0]?.entity_type),
      };
    });
  }

  @Post()
  @RequireCrmPermission("finance", "edit")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const input = parseBody(DocumentInput, body);
    const actor = auditActor(req);

    // One allowlist, shared with the console's file picker. §3's "limit file
    // types", applied here because these files are uploaded by a tenant and
    // opened by an operator and an auditor.
    const problem = documentUploadProblem({ contentType: input.contentType, bytes: input.bytes });
    if (problem) throw new BadRequestException(problem);

    return this.db.withOrg(orgId, async (client) => {
      const category = await client.query<{ id: string }>(
        `SELECT id FROM document_categories WHERE id = $1 AND archived_at IS NULL`,
        [input.categoryId],
      );
      if (!category.rows[0]) {
        throw new BadRequestException("That category does not exist, or has been archived.");
      }

      /**
       * The key carries the org and a random id, never the file name.
       *
       * 0178's reasoning applies unchanged: the org prefix keeps a mis-signed
       * URL tenant-shaped in a bucket listing, and the random id stops
       * `gst-certificate.pdf` colliding and stops the key leaking what the
       * document IS to anybody who sees a URL. A signed URL is a credential
       * and it travels through browser history and server logs.
       */
      const key = `finance-documents/${orgId}/${crypto.randomUUID()}`;

      let documentId: string;
      try {
        // `version` is max + 1 per (category, title), computed in the INSERT
        // rather than read and then written. Two uploads racing would both
        // read max = 2 and both write 3.
        const { rows } = await client.query<{ id: string; version: number }>(
          `INSERT INTO business_documents
             (org_id, category_id, title, doc_number, s3_key, file_name, content_type, bytes,
              version, issued_on, expires_on, reminder_offsets, owner_user_id, notes, uploaded_by)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8,
                  COALESCE((SELECT max(d.version) FROM business_documents d
                             WHERE d.category_id = $2 AND lower(d.title) = lower($3)), 0) + 1,
                  $9::date, $10::date, $11::int[], $12, $13, $14
           RETURNING id, version`,
          [
            orgId,
            input.categoryId,
            input.title,
            input.docNumber ?? null,
            key,
            input.fileName,
            input.contentType,
            input.bytes,
            input.issuedOn ?? null,
            input.expiresOn ?? null,
            input.reminderOffsets ?? null,
            input.ownerUserId ?? null,
            input.notes ?? null,
            actorUserId(actor),
          ],
        );
        documentId = rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException("Somebody uploaded a version at the same moment. Try again.");
        }
        throw err;
      }

      if (input.supersedesId) {
        // Marked on the OLD row, so the expiry sweep can tell a lapsed licence
        // from a renewed one without a correlated subquery per document.
        const { rowCount } = await client.query(
          `UPDATE business_documents
              SET superseded_at = now(), superseded_by = $2
            WHERE id = $1 AND deleted_at IS NULL AND superseded_at IS NULL`,
          [input.supersedesId, documentId],
        );
        if (rowCount === 0) {
          throw new BadRequestException(
            "The document this replaces does not exist, or has already been replaced.",
          );
        }
        // And the alerts about the document that was just renewed are done.
        await client.query(
          `UPDATE advisor_alerts
              SET status = 'resolved', resolved_reason = 'Renewed'
            WHERE rule_code IN ('document_expiring', 'document_expired')
              AND subject_type = 'business_document'
              AND subject_ref = $1
              AND status IN ('open', 'acknowledged')`,
          [input.supersedesId],
        );
      }

      await client.query(
        `INSERT INTO document_access_log (org_id, document_id, actor_type, actor_id, action, ip)
         VALUES ($1, $2, $3, $4, 'upload', $5)`,
        [orgId, documentId, actor.type, actor.id, req.ip ?? null],
      );

      const uploadUrl = await this.s3.presignedPutUrl(key, input.contentType, 900);
      return { id: documentId, uploadUrl, expiresInSeconds: 900 };
    });
  }

  /**
   * A short-lived signed URL, and a log row saying it was handed out.
   *
   * 300 seconds, matching the contract-document route rather than the 1800 the
   * recording player uses: a signed URL IS a credential, and a vault document
   * needs one long enough to open and no longer.
   */
  @Get(":id/url")
  @RequireCrmPermission("finance", "view")
  async url(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ s3_key: string; content_type: string; file_name: string }>(
        `SELECT s3_key, content_type, file_name
           FROM business_documents WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException("That document does not exist.");

      await client.query(
        `INSERT INTO document_access_log (org_id, document_id, actor_type, actor_id, action, ip)
         VALUES ($1, $2, $3, $4, 'url', $5)`,
        [orgId, id, actor.type, actor.id, req.ip ?? null],
      );

      const url = await this.s3.presignedGetUrl(row.s3_key, 300, row.content_type);
      return { url, expiresInSeconds: 300, fileName: row.file_name };
    });
  }

  @Patch(":id")
  @RequireCrmPermission("finance", "edit")
  async patch(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parseOptionalBody(DocumentPatch, body);
    if (Object.keys(input).length === 0) throw new BadRequestException("Nothing to change.");

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const { rows } = await client.query<DocumentRow>(
        `WITH updated AS (
           UPDATE business_documents d SET
             title = COALESCE($2, d.title),
             doc_number = CASE WHEN $3::boolean THEN $4 ELSE d.doc_number END,
             issued_on = CASE WHEN $5::boolean THEN $6::date ELSE d.issued_on END,
             expires_on = CASE WHEN $7::boolean THEN $8::date ELSE d.expires_on END,
             reminder_offsets = CASE WHEN $9::boolean THEN $10::int[] ELSE d.reminder_offsets END,
             owner_user_id = CASE WHEN $11::boolean THEN $12 ELSE d.owner_user_id END,
             notes = CASE WHEN $13::boolean THEN $14 ELSE d.notes END
           WHERE d.id = $1 AND d.deleted_at IS NULL
           RETURNING d.id
         )
         SELECT ${DOCUMENT_SELECT}
           ${DOCUMENT_FROM}
          WHERE d.id IN (SELECT id FROM updated)`,
        [
          id,
          input.title ?? null,
          "docNumber" in input,
          input.docNumber ?? null,
          "issuedOn" in input,
          input.issuedOn ?? null,
          "expiresOn" in input,
          input.expiresOn ?? null,
          "reminderOffsets" in input,
          input.reminderOffsets ?? null,
          "ownerUserId" in input,
          input.ownerUserId ?? null,
          "notes" in input,
          input.notes ?? null,
        ],
      );
      if (rows.length === 0) throw new NotFoundException("That document does not exist.");
      return presentDocument(rows[0], today);
    });
  }

  /**
   * A soft delete, and the database enforces that it is the only kind.
   *
   * 0180 REVOKEs DELETE on `business_documents` from `aura_app` and asserts it
   * from `information_schema`, because 0001's `ALTER DEFAULT PRIVILEGES` hands
   * every new table all four verbs - so a narrow GRANT would have narrowed
   * nothing. A bug that could hard-delete a signed lease deed is not a bug
   * anybody recovers from.
   */
  @Delete(":id")
  @RequireCrmPermission("finance", "edit")
  async remove(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const linked = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM compliance_filings WHERE document_id = $1`,
        [id],
      );
      if (Number(linked.rows[0].count) > 0) {
        // 0181 makes this a RESTRICT at the database level; this turns the
        // 23503 into a sentence. Deleting the challan must not erase the
        // record that the return was filed.
        throw new BadRequestException(
          "This document is attached to a filing. Detach it there first.",
        );
      }

      const { rowCount } = await client.query(
        `UPDATE business_documents
            SET deleted_at = now(), deleted_by = $2
          WHERE id = $1 AND deleted_at IS NULL`,
        [id, actorUserId(actor)],
      );
      if (rowCount === 0) throw new NotFoundException("That document does not exist.");

      await client.query(
        `INSERT INTO document_access_log (org_id, document_id, actor_type, actor_id, action, ip)
         VALUES ($1, $2, $3, $4, 'delete', $5)`,
        [orgId, id, actor.type, actor.id, req.ip ?? null],
      );
      return { ok: true };
    });
  }

  @Get(":id/access-log")
  @RequireCrmPermission("finance", "view")
  async accessLog(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        actor_type: string;
        actor_id: string;
        actor_name: string | null;
        action: string;
        at: string;
      }>(
        `SELECT l.actor_type, l.actor_id, u.name AS actor_name, l.action, l.at::text AS at
           FROM document_access_log l
           LEFT JOIN users u ON u.id::text = l.actor_id
          WHERE l.document_id = $1
          ORDER BY l.at DESC
          LIMIT 200`,
        [id],
      );
      return {
        entries: rows.map((r) => ({
          actor: { type: r.actor_type, id: r.actor_id, name: r.actor_name },
          action: r.action,
          at: r.at,
        })),
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function presentDocument(row: DocumentRow, today: string) {
  // The document's own offsets win; absent, the category's apply. NULL means
  // "use the category's", which is why the column is nullable rather than
  // defaulting to an empty array - an empty array means "never remind".
  const offsets = row.reminder_offsets ?? row.category_offsets ?? [];
  const doc = { expiresOn: row.expires_on };
  return {
    id: row.id,
    category: {
      id: row.category_id,
      code: row.category_code,
      label: row.category_label,
      group: row.doc_group,
      groupLabel: DOCUMENT_GROUP_LABELS[row.doc_group as DocumentGroup] ?? row.doc_group,
    },
    title: row.title,
    docNumber: row.doc_number,
    fileName: row.file_name,
    contentType: row.content_type,
    bytes: Number(row.bytes),
    version: row.version,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    // Derived, like every other status in this module.
    expiryStatus: documentExpiryStatus(doc, today, offsets),
    daysUntilExpiry: daysUntilExpiry(doc, today),
    reminderOffsets: offsets,
    reminderOffsetsAreOwn: row.reminder_offsets !== null,
    superseded: row.superseded_at !== null,
    supersededAt: row.superseded_at,
    owner: row.owner_user_id ? { id: row.owner_user_id, name: row.owner_name } : null,
    notes: row.notes,
    uploadedBy: row.uploaded_by_name,
    createdAt: row.created_at,
  };
}

function isUuid(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
