import { Body, Controller, Headers, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import type { LeadSourceKind } from "@aura/shared";
import { LeadIntakeService, type IntakeRequest } from "./lead-intake.service";

/**
 * The public front doors of the lead intake engine (migration 0078).
 *
 * ── WHY THESE ROUTES CARRY NO GUARD ─────────────────────────────────────
 *
 * A form on a customer's website, an Exotel passthrough and a Mailgun route
 * cannot present an admin key or an org header. The `:token` path segment IS
 * the credential: a CSPRNG value in `lead_sources.intake_token`, UNIQUE
 * platform-wide, and resolving it both authenticates the caller and names the
 * tenant. Exactly the shape `messaging/webhook/:token` has had since 0056.
 *
 * They are registered in guard-mounting.spec.ts's UNGUARDED list for the same
 * reason /auth/login is: unguarded BY DESIGN, asserted so it cannot become
 * unguarded by accident.
 *
 * An unknown, malformed or over-long token gets a 404 and nothing else - no
 * hint that a token exists, no tenant name, no echo of the payload. A token
 * belonging to a PAUSED source is deliberately different: it resolves, and the
 * arrival is recorded as rejected, because "we paused it and the leads stopped"
 * is something the tenant should be able to see rather than deduce.
 *
 * ── THEY ALWAYS ANSWER 2xx ONCE THE TOKEN IS GOOD ───────────────────────
 *
 * Every provider behind these routes retries on a non-2xx. A payload we cannot
 * parse is therefore NOT a 500 - that has the provider replay the same
 * unparseable body for hours. It is a 202 carrying the outcome, and the reason
 * lands on the source's page in the console where somebody can fix the mapping.
 *
 * ── THROTTLED, AND WHY THAT IS SAFE HERE ────────────────────────────────
 *
 * 300/min per IP. `@SkipThrottle()` exists in this codebase only for the
 * device beacon, whose written rationale is that dropping it loses recordings.
 * Nothing here has that property: every provider retries, and a browser form
 * submitted 300 times in a minute from one address is not a customer. It also
 * bounds the cost of somebody who finds a form token in a page's HTML, which
 * is the one abuse case these routes actually have.
 */
@Controller("intake")
@Throttle({ default: { limit: 300, ttl: 60_000 } })
export class IntakeWebhookController {
  constructor(private readonly intake: LeadIntakeService) {}

  /**
   * A form on the tenant's own site.
   *
   * Answers CORS from any origin (see config/cors.ts) because the posting site
   * is tenant data. The source's own `allowedOrigins` is enforced here instead,
   * where a refusal can be recorded and shown.
   */
  @Post("form/:token")
  async form(
    @Param("token") token: string,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
    @Headers("origin") origin?: string,
  ) {
    return this.receive("web_form", token, body, req, origin ?? null);
  }

  /** A cloud telephony vendor's call or missed-call callback. */
  @Post("telephony/:token")
  async telephony(@Param("token") token: string, @Body() body: unknown, @Req() req: RawBodyRequest<Request>) {
    return this.receive("telephony", token, body, req, null);
  }

  /**
   * An inbound mail relay delivering a parsed message.
   *
   * The tenant forwards their enquiry inbox (sales@, info@) to the address
   * their relay routes here. That is a categorically different thing from the
   * mailbox sync in email-sync.ts, which polls a REP'S OWN mailbox and
   * deliberately records only messages whose counterparty is already a contact
   * - because a rep's mailbox holds their payslips and their doctor. An
   * enquiry inbox is a published address that exists to receive strangers, so
   * a stranger's message becoming a lead is the entire point rather than a
   * privacy breach. The two paths stay separate for that reason.
   */
  @Post("email/:token")
  async email(@Param("token") token: string, @Body() body: unknown, @Req() req: RawBodyRequest<Request>) {
    return this.receive("email", token, body, req, null);
  }

  private async receive(
    expected: LeadSourceKind,
    token: string,
    body: unknown,
    req: RawBodyRequest<Request>,
    origin: string | null,
  ) {
    // Length-bounded before it reaches the database: the token is a fixed-size
    // generated value, so anything wildly outside that is a probe, not a typo.
    if (typeof token !== "string" || token.length < 16 || token.length > 200) {
      throw new NotFoundException("unknown intake endpoint");
    }

    const source = await this.intake.resolveSource(token);
    if (!source) throw new NotFoundException("unknown intake endpoint");

    // A telephony token posted to the form endpoint is a misconfiguration, and
    // answering it would apply the wrong field map to a real payload and
    // produce a lead full of nonsense. Refusing without saying which channel
    // the token IS for keeps the 404 uninformative.
    if (source.kind !== expected) throw new NotFoundException("unknown intake endpoint");

    const payload = normalisePayload(body);
    const request: IntakeRequest = {
      payload,
      headers: req.headers as Record<string, string | string[] | undefined>,
      url: absoluteUrl(req),
      rawBody: req.rawBody,
      origin,
    };

    const result = await this.intake.ingestPayload(source, request);
    // `reason` goes back to the caller on purpose for the form channel: a
    // developer wiring a form up needs to see "no name, phone or email could be
    // read" while they are looking at the network tab, and it discloses nothing
    // about the tenant that the person posting the form does not already have.
    return {
      ok: true,
      outcome: result.outcome,
      leadId: result.leadId,
      reason: result.reason,
    };
  }
}

/**
 * Whatever express parsed, as a flat object of scalars.
 *
 * Form-encoded posts (Twilio, Exotel, SendGrid) arrive as strings; JSON posts
 * arrive as objects and are passed through so nested paths like
 * `mail.commonHeaders.subject` still resolve. A body that is an array or a
 * bare string is not something any provider here sends, and wrapping it rather
 * than rejecting keeps it visible in the ledger where it can be diagnosed.
 */
function normalisePayload(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return { body: body === undefined ? null : body };
}

/**
 * The URL the provider actually called, for Twilio's signature.
 *
 * Twilio signs the exact string configured in its console, so the proxy
 * headers matter: behind Caddy the request arrives as plain http on the
 * container, and computing the HMAC over `http://` when Twilio signed
 * `https://` fails every signature. `trust proxy` is already set in main.ts,
 * which is what makes `req.protocol` reflect X-Forwarded-Proto.
 */
function absoluteUrl(req: Request): string {
  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost?.split(",")[0]?.trim() || req.get("host") || "";
  return `${req.protocol}://${host}${req.originalUrl}`;
}
