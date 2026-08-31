import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PoolClient } from "@aura/db";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ErasureBody = z.object({
  /** Erase everything tied to one call, or (later) a subject phone hash. */
  callId: z.string().uuid(),
});

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "ap-south-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "aura_minio",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "aura_minio_password",
  },
});
const BUCKET = process.env.S3_BUCKET ?? "aura-recordings";

/**
 * Cascading erasure (§2.6, GDPR Art. 17 / DPDP): S3 object → lead → contact/deal
 * → transcript → ai_outputs → call_facts → crm_sync_log → call row, then a
 * signed receipt recorded in the audit log. CRM-pushed copies are best-effort/
 * logged (TODO with the HubSpot connector). Per-subject (phone-hash) fan-out
 * lands later.
 *
 * A call the caller's org cannot see is a 404 and mints nothing - see the note
 * on the lookup below for why that ordering is the whole contract.
 *
 * Known, disclosed residual gap: a contact/deal that survives because it has
 * another legitimate link (see eraseCrmObjects below) is NOT scrubbed of the
 * erased call's specific contribution to its free-text `facts`/`notes` - no
 * per-field provenance exists for that blob (only custom-field VALUES have
 * `source`, since migration 0045). An honest "retained" entry on the receipt
 * beats a receipt that claims a scrub it cannot actually perform.
 */
@Controller("erasure-requests")
@UseGuards(AdminKeyGuard, TenantGuard)
export class ErasureController {
  constructor(private readonly db: DbService) {}

  @Post()
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async erase(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = ErasureBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { callId } = parsed.data;

    // Resolve the call under RLS, but don't hold that transaction/connection
    // open across the S3 delete below - this is operator-triggered rather than
    // a hot path, but the network call still has no business sitting inside a
    // BEGIN…COMMIT the same way the ingest endpoints' S3 calls didn't.
    const rec = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `SELECT r.s3_key, c.remote_number_hash
           FROM calls c LEFT JOIN recordings r ON r.call_id = c.id
          WHERE c.id = $1`,
        [callId],
      );

      // Resolve the call BEFORE anything is erased and, more importantly, before
      // anything is signed. `withOrg` means RLS hides another tenant's call, so a
      // miss here is "not yours or not there" - and every DELETE below is keyed on
      // call_id alone, so without this the handler ran its whole cascade against
      // zero rows and still minted an HMAC-signed receipt saying COMPLETED. Report
      // 12 §3.6: a receipt that overstates what was deleted is worse than one that
      // admits a gap, and a signed artefact must never be issued on a path that
      // resolved nothing. LEFT JOIN, so a call with no recording still yields a
      // row - `!row` means the CALL is absent, not the audio.
      //
      // Consequence worth knowing: erasure is no longer idempotent. Re-sending a
      // request for an already-erased call now 404s instead of returning a second
      // empty receipt. That is the intended reading - the only truthful receipt
      // for that call is the one already in audit_log.
      if (!row) throw new NotFoundException("call not found in this org");
      return row;
    });

    // Outside any transaction / pool connection now. S3 goes first, same as
    // before: nothing in the DB has been touched yet, so a failure here still
    // leaves everything retryable and mints no receipt.
    const purged: string[] = [];
    if (rec?.s3_key) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: rec.s3_key }));
      purged.push("s3_audio_object");
    }

    return this.db.withOrg(orgId, async (client) => {
      // The lead carries the subject's name and everything the call said about
      // them, so erasing the call without it would leave the data behind under
      // a different table name. Matched on the contact hash - one erasure
      // request removes the prospect, not just this one conversation.
      //
      // Resolved (not yet deleted) BEFORE eraseCrmObjects runs: deals' and
      // contacts' `source_lead_id` are ON DELETE SET NULL (0035/0036), so
      // deleting these leads first would erase the very link eraseCrmObjects
      // needs in order to find its own candidates - a real bug caught only by
      // running this live, not by anything a typecheck could see.
      const { rows: candidateLeads } = await client.query<{ id: string }>(
        `SELECT id FROM leads
          WHERE first_call_id = $1 OR last_call_id = $1
             OR ($2::text IS NOT NULL AND contact_number_hash = $2)`,
        [callId, rec?.remote_number_hash ?? null],
      );
      const candidateLeadIds = candidateLeads.map((r) => r.id);

      // The lead's eventual erasure below does NOT cascade to contacts/deals
      // - both FKs are ON DELETE SET NULL, by design, since a contact can
      // outlive any one lead once dedup is org-wide. Resolve and erase them
      // explicitly, the same "who else still points here" question the lead
      // DELETE below already answers for the phone-hash fan-out.
      const { purged: crmPurged, retainedContactIds } = await this.eraseCrmObjects(
        client,
        callId,
        rec?.remote_number_hash ?? null,
        candidateLeadIds,
      );
      purged.push(...crmPurged);

      const leadRes = await client.query("DELETE FROM leads WHERE id = ANY($1::uuid[])", [
        candidateLeadIds,
      ]);
      if ((leadRes.rowCount ?? 0) > 0) purged.push("lead_rows");

      for (const [table, label] of [
        ["transcripts", "transcript_rows"],
        ["ai_outputs", "ai_output_rows"],
        ["call_facts", "call_fact_rows"],
        ["crm_sync_log", "crm_sync_rows"],
        ["recordings", "recording_rows"],
      ] as const) {
        const res = await client.query(`DELETE FROM ${table} WHERE call_id = $1`, [callId]);
        if ((res.rowCount ?? 0) > 0) purged.push(label);
      }
      const callRes = await client.query("DELETE FROM calls WHERE id = $1", [callId]);
      if ((callRes.rowCount ?? 0) > 0) purged.push("call_row");

      const receipt = {
        status: "COMPLETED",
        callId,
        purged,
        // Never claim a scrub that didn't happen: a contact retained here
        // still has another legitimate link (a hand-created deal, a manual
        // note, a task) - see the class docstring for the disclosed gap.
        retainedContactIds,
        erasedAtUtc: new Date().toISOString(),
      };
      const signature = createHmac(
        "sha256",
        process.env.JWT_SECRET ?? "dev-jwt-secret-change-me",
      )
        .update(JSON.stringify(receipt))
        .digest("hex");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'erasure.complete', 'call', $3, $4)`,
        [orgId, req.principal?.userId ?? "dev-admin", callId, JSON.stringify({ ...receipt, signature })],
      );

      return { ...receipt, signature, receiptHash: createHash("sha256").update(signature).digest("hex") };
    });
  }

  /**
   * Erases every deal/contact whose ONLY provenance is the erased lead(s)/
   * call, and retains anything with another legitimate link. Order matters:
   * deals are resolved and deleted first, so the contact "safe to delete"
   * check below sees a contact with no deals left rather than racing against
   * ones about to be removed anyway.
   *
   * `status <> 'merged'` on the contact candidate query is deliberate, not an
   * oversight: 0038 tombstones a merge victim (status='merged',
   * merged_into_id set) rather than deleting it, because merge_log/revert
   * need that row to still exist. Hard-deleting one here - even one with no
   * other links - would corrupt that audit trail, so a merged contact is
   * never a candidate at all.
   */
  private async eraseCrmObjects(
    client: PoolClient,
    callId: string,
    phoneHash: string | null,
    deletedLeadIds: string[],
  ): Promise<{ purged: string[]; retainedContactIds: string[] }> {
    const purged: string[] = [];

    const { rows: dealRows } = await client.query(
      `SELECT id FROM deals
        WHERE source_lead_id = ANY($1::uuid[])
           OR id IN (SELECT deal_id FROM interactions WHERE call_id = $2 AND deal_id IS NOT NULL)`,
      [deletedLeadIds, callId],
    );
    if (dealRows.length > 0) {
      await client.query("DELETE FROM deals WHERE id = ANY($1::uuid[])", [
        dealRows.map((r) => r.id as string),
      ]);
      purged.push("deal_rows");
    }

    const { rows: contactRows } = await client.query(
      `SELECT id FROM contacts
        WHERE status <> 'merged'
          AND ( ($1::text IS NOT NULL AND phone_hash = $1)
             OR source_lead_id = ANY($2::uuid[])
             OR id IN (SELECT contact_id FROM interactions WHERE call_id = $3 AND contact_id IS NOT NULL) )`,
      [phoneHash, deletedLeadIds, callId],
    );

    const retainedContactIds: string[] = [];
    let deletedAnyContact = false;
    if (contactRows.length > 0) {
      const contactIds = contactRows.map((r) => r.id as string);
      // One set-based query instead of one safe_to_delete round trip per
      // candidate contact: a LEFT JOIN against every blocking link, grouped
      // back down to one row per contact. bool_and(...) is true exactly when
      // no blocking row joined for that contact - the same predicate the old
      // per-row NOT EXISTS(...) computed, just batched.
      const { rows: safety } = await client.query<{ id: string; safe_to_delete: boolean }>(
        `SELECT ids.id,
                bool_and(b.contact_id IS NULL) AS safe_to_delete
           FROM unnest($1::uuid[]) AS ids(id)
           LEFT JOIN (
             SELECT contact_id FROM deals WHERE contact_id = ANY($1::uuid[])
             UNION ALL
             SELECT contact_id FROM interactions WHERE contact_id = ANY($1::uuid[]) AND call_id IS NULL
             UNION ALL
             SELECT contact_id FROM tasks WHERE contact_id = ANY($1::uuid[]) AND deal_id IS NULL
           ) b ON b.contact_id = ids.id
          GROUP BY ids.id`,
        [contactIds],
      );

      const deletableIds: string[] = [];
      for (const row of safety) {
        if (row.safe_to_delete) deletableIds.push(row.id);
        else retainedContactIds.push(row.id);
      }
      if (deletableIds.length > 0) {
        await client.query("DELETE FROM contacts WHERE id = ANY($1::uuid[])", [deletableIds]);
        deletedAnyContact = true;
      }
    }
    if (deletedAnyContact) purged.push("contact_rows");

    return { purged, retainedContactIds };
  }
}
