import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CallAccessGuard, CallContent } from "../../common/call-access.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { auditActor } from "../../common/audit-actor";

const CreateNoteBody = z.object({
  body: z.string().min(1).max(10000),
});

/** Reviewer notes attached to a call (§4 Call Explorer). Separate controller so
 * the device-facing CallsController stays focused; shares the /v1/calls prefix.
 *
 * `@CallContent()` at the class, covering both routes: a note is somebody
 * writing down what was said on the call, so it is call content by any reading
 * that matters to the person who was recorded. Gating the transcript and
 * leaving the prose about it open would be a distinction only the schema
 * cares about. */
@Controller("calls")
@UseGuards(AdminKeyGuard, TenantGuard, CallAccessGuard)
@CallContent()
export class NotesController {
  constructor(private readonly db: DbService) {}

  @Get(":id/notes")
  async list(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, body, author, created_at
           FROM call_notes WHERE call_id = $1 ORDER BY created_at DESC`,
        [callId],
      );
      return { notes: rows };
    });
  }

  @Post(":id/notes")
  async create(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = CreateNoteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      // FK checks bypass RLS, so confirm the call is visible in this org first.
      const call = await client.query("SELECT 1 FROM calls WHERE id = $1", [callId]);
      if (call.rowCount === 0) throw new NotFoundException("call not found");

      const {
        rows: [note],
      } = await client.query(
        `INSERT INTO call_notes (org_id, call_id, body, author)
         VALUES ($1, $2, $3, 'dev-admin')
         RETURNING id, body, author, created_at`,
        [orgId, callId, parsed.data.body],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, $4, $2, 'call.note', 'call', $3)`,
        [orgId, auditActor(req).id, callId, auditActor(req).type],
      );
      return note;
    });
  }
}
