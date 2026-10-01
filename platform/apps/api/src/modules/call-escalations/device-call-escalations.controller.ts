import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { DeviceRaiseCallEscalationInput, type DeviceCallEscalationView } from "@aura/shared";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { DbService } from "../../db/db.service";
import { CallEscalationsService, loadRaiseContext } from "./call-escalations.service";

/**
 * The handset's side of call escalations (migration 0151, Build docs/38): the
 * "Escalate" item on an uploaded recording, and the status of what this phone's
 * telecaller has escalated.
 *
 * DeviceAuthGuard like every `devices/me` route: the signed device token IS the
 * identity, and the telecaller is ALWAYS the active one the device is bound to
 * at the moment of the request - never a value from the body. The call must be
 * that telecaller's own (`calls.telecaller_id`).
 *
 * Not throttled, for the reason device-telemetry.controller.ts gives: a
 * tenant's phones share one NAT address.
 *
 * The workspace switch is enforced HERE (403 escalation_disabled); the phone
 * hiding the menu item when the config block is absent is a convenience.
 */
@Controller("devices/me")
@UseGuards(DeviceAuthGuard)
@SkipThrottle()
export class DeviceCallEscalationsController {
  constructor(
    private readonly db: DbService,
    private readonly escalations: CallEscalationsService,
  ) {}

  /**
   * Escalate one of this telecaller's calls.
   *
   * Idempotent on the phone's own `clientRef`: a press retried after a lost
   * response is stored once, and the replay gets the stored escalation back
   * with `duplicate: true` - even if the switch went off in between, since the
   * escalation already exists. A second press on a call that already has a
   * live escalation returns that one, `duplicate: true`, too.
   */
  @Post("calls/:callId/escalations")
  async raise(
    @Req() req: DeviceRequest,
    @Param("callId", ParseUUIDPipe) callId: string,
    @Body() body: unknown,
  ): Promise<{ escalation: DeviceCallEscalationView; duplicate: boolean }> {
    const parsed = DeviceRaiseCallEscalationInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const { deviceId, orgId } = req.device;

    const out = await this.db.withOrg(orgId, async (client) => {
      const ctx = await loadRaiseContext(client, { kind: "device", deviceId, clientRef: input.clientRef }, callId);
      if (!ctx) throw new UnauthorizedException("device not found");

      // A replay short-circuits before anything else, so it never notifies twice.
      if (ctx.replay_id) {
        const view = await this.escalations.readDeviceView(client, ctx.replay_id);
        if (!view) throw new ConflictException("the escalation could not be read back - try again");
        return { view, duplicate: true, tokens: [] as string[], fresh: false };
      }
      if (!ctx.device_ok) {
        throw new ForbiddenException({ code: "device_inactive", message: "This phone is not active. Ask your manager." });
      }
      if (ctx.enabled !== true) {
        throw new ForbiddenException({
          code: "escalation_disabled",
          message: "Escalations are switched off for your workspace. Handle the call yourself.",
        });
      }
      if (!ctx.tc_id) {
        throw new ConflictException({
          code: "not_assigned",
          message: "This phone is not assigned to a telecaller yet. Ask your manager.",
        });
      }
      if (!ctx.call_found || ctx.call_telecaller_id !== ctx.tc_id) {
        throw new NotFoundException({ code: "call_not_found", message: "That call is not one of yours." });
      }

      const r = await this.escalations.raise(client, {
        ctx,
        orgId,
        callId,
        reason: input.reason,
        note: input.note?.trim() || null,
        source: "device",
        deviceId,
        clientRef: input.clientRef,
        // The telecaller's console login, when they have one - so the answer
        // also reaches their bell. May be null: most telecallers have none.
        raisedByUserId: ctx.tc_user_id,
        actorName: ctx.tc_name ?? "A telecaller",
        audit: { type: "device", id: deviceId },
      });
      const view = await this.escalations.readDeviceView(client, r.id);
      if (!view) throw new ConflictException("the escalation could not be read back - try again");
      return { view, duplicate: r.duplicate, tokens: r.tokens, fresh: !r.duplicate };
    });

    this.escalations.pushAlerts(out.tokens);
    // `devices/me` is a SILENT prefix for the realtime interceptor, so the
    // console's queue is told explicitly.
    if (out.fresh) this.escalations.announce(orgId, out.view.id);
    return { escalation: out.view, duplicate: out.duplicate };
  }

  /**
   * The status of every call this telecaller escalated in the last 30 days
   * (and any older one still live) - the phone shows it on each recording's
   * row. Read even while the switch is off: what was raised stays answerable,
   * and the telecaller should see the answer. Empty for a phone bound to nobody.
   */
  @Get("escalations")
  async list(@Req() req: DeviceRequest): Promise<{ escalations: DeviceCallEscalationView[] }> {
    const { deviceId, orgId } = req.device;
    const escalations = await this.db.withOrg(orgId, (client) => this.escalations.readDeviceList(client, deviceId));
    return { escalations };
  }
}
