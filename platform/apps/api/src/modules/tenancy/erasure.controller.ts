import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
  UseGuards,
} from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
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
 * Cascading erasure (§2.6, GDPR Art. 17 / DPDP): S3 object → lead → transcript →
 * ai_outputs → call_facts → crm_sync_log → call row, then a signed receipt
 * recorded in the audit log. CRM-pushed copies are best-effort/logged (TODO
 * with the HubSpot connector). Per-subject (phone-hash) fan-out lands later.
 *
 * A call the caller's org cannot see is a 404 and mints nothing — see the note
 * on the lookup below for why that ordering is the whole contract.
 */
@Controller("erasure-requests")
@UseGuards(AdminKeyGuard, TenantGuard)
export class ErasureController {
  constructor(private readonly db: DbService) {}

  @Post()
  async erase(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = ErasureBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { callId } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [rec],
      } = await client.query(
        `SELECT r.s3_key, c.remote_number_hash
           FROM calls c LEFT JOIN recordings r ON r.call_id = c.id
          WHERE c.id = $1`,
        [callId],
      );

      // Resolve the call BEFORE anything is erased and, more importantly, before
      // anything is signed. `withOrg` means RLS hides another tenant's call, so a
      // miss here is "not yours or not there" — and every DELETE below is keyed on
      // call_id alone, so without this the handler ran its whole cascade against
      // zero rows and still minted an HMAC-signed receipt saying COMPLETED. Report
      // 12 §3.6: a receipt that overstates what was deleted is worse than one that
      // admits a gap, and a signed artefact must never be issued on a path that
      // resolved nothing. LEFT JOIN, so a call with no recording still yields a
      // row — `!rec` means the CALL is absent, not the audio.
      //
      // Consequence worth knowing: erasure is no longer idempotent. Re-sending a
      // request for an already-erased call now 404s instead of returning a second
      // empty receipt. That is the intended reading — the only truthful receipt
      // for that call is the one already in audit_log.
      if (!rec) throw new NotFoundException("call not found in this org");

      const purged: string[] = [];
      if (rec?.s3_key) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: rec.s3_key }));
        purged.push("s3_audio_object");
      }

      // The lead carries the subject's name and everything the call said about
      // them, so erasing the call without it would leave the data behind under
      // a different table name. Matched on the contact hash — one erasure
      // request removes the prospect, not just this one conversation.
      const leadRes = await client.query(
        `DELETE FROM leads
          WHERE first_call_id = $1 OR last_call_id = $1
             OR ($2::text IS NOT NULL AND contact_number_hash = $2)`,
        [callId, rec?.remote_number_hash ?? null],
      );
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
         VALUES ($1, 'user', 'dev-admin', 'erasure.complete', 'call', $2, $3)`,
        [orgId, callId, JSON.stringify({ ...receipt, signature })],
      );

      return { ...receipt, signature, receiptHash: createHash("sha256").update(signature).digest("hex") };
    });
  }
}
