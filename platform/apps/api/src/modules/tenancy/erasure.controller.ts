import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UseGuards,
} from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { orgIdFromHeader } from "../../common/org-context";
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
 * Cascading erasure (§2.6, GDPR Art. 17 / DPDP): S3 object → transcript →
 * ai_outputs → call_facts → crm_sync_log → call row, then a signed receipt
 * recorded in the audit log. CRM-pushed copies are best-effort/logged (TODO
 * with the HubSpot connector). Per-subject (phone-hash) fan-out lands later.
 */
@Controller("erasure-requests")
@UseGuards(AdminKeyGuard)
export class ErasureController {
  constructor(private readonly db: DbService) {}

  @Post()
  async erase(@Headers("x-org-id") orgHeader: string | undefined, @Body() body: unknown) {
    const orgId = orgIdFromHeader(orgHeader);
    const parsed = ErasureBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { callId } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [rec],
      } = await client.query(
        "SELECT s3_key FROM recordings WHERE call_id = $1",
        [callId],
      );

      const purged: string[] = [];
      if (rec?.s3_key) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: rec.s3_key }));
        purged.push("s3_audio_object");
      }
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
