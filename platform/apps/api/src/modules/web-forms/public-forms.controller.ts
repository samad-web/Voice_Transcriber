import { BadRequestException, Body, Controller, Get, Headers, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { WEB_FORM_SLUG_RE, type PublicWebForm } from "@aura/shared/dist/web-forms";
import {
  WebFormSubmissionService,
  type WebFormSubmitResult,
} from "./web-form-submission.service";

/**
 * The public front door of a hosted form (migration 0161, Build docs/39 §16).
 *
 * ── WHY THESE ROUTES CARRY NO GUARD ────────────────────────────────────────
 *
 * The same reason `IntakeWebhookController`'s do, with one difference worth
 * stating plainly: there, the `:token` path segment IS the credential. Here
 * the `:slug` is NOT a credential and is not pretending to be one. A public
 * form is a page on the open internet that exists to be filled in by
 * strangers; anybody who can load it can submit it, and that is the product.
 *
 * What stands between it and abuse is therefore not secrecy:
 *
 *   - `status = 'published'`. A draft or closed form 404s, and the two are
 *     indistinguishable from a slug that never existed.
 *   - the honeypot, enforced by 0078's `screen()` and recorded in the ledger.
 *   - the throttle below, and the source's origin list.
 *   - the intake pipeline's own dedupe, so a replayed submission is one lead.
 *
 * They belong in guard-mounting.spec.ts's UNGUARDED list for the same reason
 * `/auth/login` does: unguarded BY DESIGN, asserted so it cannot become
 * unguarded by accident.
 *
 * ── THEY ARE NOT UNDER THE API-KEY `public` CONTROLLER ─────────────────────
 *
 * `PublicApiController` is also mounted at `public` and is guarded by
 * `ApiKeyGuard`. Nest routes these independently and there is no overlap -
 * that one owns `public/leads`, `public/contacts`, `public/deals`,
 * `public/projects` - but the name is close enough to mislead a reader, so:
 * nothing in THIS file takes a key, and nothing in it reads tenant data. The
 * GET returns what is already rendered into a public page; the POST writes a
 * lead and returns an outcome.
 *
 * ── THROTTLED, AND WHOSE IP IT COUNTS ──────────────────────────────────────
 *
 * 300/min, matching `IntakeWebhookController` - every real caller here is a
 * person pressing a button once.
 *
 * The count is per source IP, and the hosting app is a proxy: the marketing
 * container forwards each submission with the visitor's address in
 * `x-forwarded-for`, and `app.set("trust proxy", 1)` in main.ts is what makes
 * express read it back as `req.ip`. WITHOUT that forwarding every tenant's
 * forms would share one bucket and a busy afternoon on one form would throttle
 * every other tenant's - which is the failure this note exists to stop
 * somebody reintroducing by "simplifying" the fetch in
 * apps/marketing/app/f/[slug]/submit/route.ts.
 */

/** Everything the hosting page sends. Nothing in it is trusted. */
const SubmitBody = z.object({
  /**
   * Field key -> answer, exactly as the renderer collected it. Validated
   * against the form's own definition by the SAME function the renderer ran,
   * so a request that skipped the browser is checked identically.
   */
  answers: z.record(z.string().max(64), z.unknown()).default({}),
  /** The form-level consent box (`web_forms.consent_required`). */
  consent: z.boolean().optional(),
  /** The honeypot, passed straight through to 0078's screen(). */
  honeypot: z.string().max(200).nullish(),
  /** Stable across a retry of the same submission - see the service. */
  submissionId: z.string().max(64).nullish(),
  context: z
    .object({
      pageUrl: z.string().max(500).nullish(),
      referrer: z.string().max(500).nullish(),
      utm: z.record(z.string().max(40), z.string().max(200)).nullish(),
    })
    .optional(),
  /**
   * The browser's Origin, forwarded by the hosting app.
   *
   * Not read from the request's own `Origin` header, because that header
   * belongs to the marketing container when it proxies - it would report our
   * own origin for every tenant and make the source's allowed-origins list
   * meaningless. A caller posting here directly has no reason to set it and
   * `isOriginAllowed` treats an absent origin as allowed, which 0078's own
   * header explains at length: a server-side POST has no Origin at all, so an
   * origin list is hygiene and never a security boundary.
   */
  origin: z.string().max(200).nullish(),
});

@Controller("public/forms")
@Throttle({ default: { limit: 300, ttl: 60_000 } })
export class PublicFormsController {
  constructor(private readonly submissions: WebFormSubmissionService) {}

  /** The published form, as the renderer needs it. 404 for anything else. */
  @Get(":slug")
  async form(@Param("slug") slug: string): Promise<PublicWebForm> {
    return this.submissions.publicForm(assertSlug(slug));
  }

  /**
   * One submission.
   *
   * Answers 200 for every outcome the pipeline treats as handled - created,
   * updated, duplicate AND rejected. A honeypot refusal looking different from
   * a success is how a bot learns which field gave it away, and
   * `apps/marketing`'s own funnel already takes that line in so many words
   * ("Answer as if it succeeded, so a bot learns nothing from the
   * difference"). A field-level problem is a 400 carrying the per-field
   * messages, because that one is a human who needs to fix something.
   */
  @Post(":slug")
  async submit(
    @Param("slug") slug: string,
    @Body() body: unknown,
    @Headers("origin") headerOrigin?: string,
  ): Promise<WebFormSubmitResult> {
    const parsed = SubmitBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.submissions.submit(assertSlug(slug), {
      ...parsed.data,
      origin: parsed.data.origin ?? headerOrigin ?? null,
    });
  }
}

/**
 * Length- and shape-bounded before it reaches the database.
 *
 * A 400 and not a 404 so a genuinely malformed link is distinguishable from a
 * form that has closed - there is nothing to disclose here, the shape of a
 * slug is published in the console next to every form.
 */
function assertSlug(slug: string): string {
  if (typeof slug !== "string" || slug.length < 3 || slug.length > 60 || !WEB_FORM_SLUG_RE.test(slug)) {
    throw new BadRequestException("that is not a form address");
  }
  return slug;
}
