import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  WebFormDefinition,
  WebFormFieldMap,
  WebFormSlug,
  WebFormTheme,
  WEB_FORM_DEFAULT_CONSENT_TEXT,
} from "@aura/shared/dist/web-forms";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, hasCrmGrant, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { generateIntakeToken } from "../lead-intake/lead-intake.service";
import {
  WEB_FORM_COLUMNS,
  WEB_FORM_FROM,
  WebFormsService,
  webFormDto,
  type WebFormRow,
} from "./web-forms.service";

/**
 * The console's half of the form builder (migration 0161, Build docs/39 §15).
 *
 * ── THREE ROUTES, AND THE ONE THAT IS MISSING ──────────────────────────────
 *
 * List, create, read, change. There is NO delete, and 0161 says why at length:
 * a form's `lead_sources` row is what every lead it ever produced is
 * attributed to, so deleting the form would leave an attribution report
 * pointing at a source nobody can name - and the published link, which by then
 * is in an email signature and on a printed card, would 404 instead of saying
 * the form has closed. Retirement is `PATCH {"status":"closed"}`, exactly as
 * 0158 retires a DNC list and 0111 releases an opt-out. `ENFORCED_PERMISSIONS`
 * therefore must not gain `web_form:delete`: a cell with no route behind it is
 * a checkbox that lies.
 *
 * ── WHO MAY DO WHAT ────────────────────────────────────────────────────────
 *
 * `web_form:view` is seeded to every system role including `viewer` - a form
 * row holds a definition, a slug and a counter, there is no customer in it,
 * and the page itself is on the open internet. `web_form:create` and
 * `web_form:edit` go to the three admin roles only: publishing a form puts a
 * page carrying the tenant's name on the internet under a consent sentence
 * that becomes the basis for every number it collects, and `edit` includes
 * rewriting that sentence. An owner can widen either on Team & permissions,
 * which is why the list response carries `can`.
 *
 * ── WHY SOURCE ATTRIBUTION IS NOT EDITABLE HERE ────────────────────────────
 *
 * A form's `lead_sources` row carries the campaign, the project and the
 * default owner every lead from it inherits - and all three are already
 * editable on the Lead sources screen (0078), by a controller that validates
 * them against the org. Re-offering them here would be two writers for one
 * row. The response carries `sourceId` so the console can link straight to it.
 */

const Name = z.string().trim().min(1, "Name this form.").max(120);

/**
 * Where a visitor is sent after submitting, when the tenant wants their own
 * thank-you page.
 *
 * Absolute http(s) only, and checked with `URL` rather than a regex. A
 * relative value here would resolve against the MARKETING app and send
 * somebody to a page on our site that the tenant thinks is theirs; a
 * `javascript:` one would be stored XSS with a redirect for a delivery
 * mechanism, on a page we host and anybody can open.
 */
const RedirectUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }, "Enter a full link starting with https://");

const CreateForm = z.object({
  name: Name,
  /** Optional: the name is slugified when it is absent. */
  slug: WebFormSlug.optional(),
  definition: WebFormDefinition.default({ fields: [] }),
  fieldMap: WebFormFieldMap.default({}),
  consentRequired: z.boolean().default(true),
  consentText: z.string().trim().max(1000).nullish(),
  theme: WebFormTheme.default({}),
  redirectUrl: RedirectUrl.nullish(),
  thankYouText: z.string().trim().max(2000).nullish(),
  /** Which desk the leads land on. NULL is the org's first workspace (0078). */
  workspaceId: z.string().uuid().nullish(),
});

/**
 * HAND-BUILT, not `CreateForm.partial()`.
 *
 * `.partial()` keeps `.default()`, so a PATCH that omits `consentRequired`
 * would silently rewrite it to `true` - and on this table that is not a
 * cosmetic default: it is the value §16 turns into the consent basis on every
 * number the form collects. There is one live instance of that bug in outreach
 * cadences and doc 39 flags it again for the dialer's PATCH. `CreateForm` has
 * four defaults, so the shortcut here would be wrong on the day it was written.
 */
const PatchForm = z
  .object({
    name: Name.optional(),
    slug: WebFormSlug.optional(),
    definition: WebFormDefinition.optional(),
    fieldMap: WebFormFieldMap.optional(),
    consentRequired: z.boolean().optional(),
    consentText: z.string().trim().max(1000).nullish(),
    theme: WebFormTheme.optional(),
    redirectUrl: RedirectUrl.nullish(),
    thankYouText: z.string().trim().max(2000).nullish(),
    status: z.enum(["draft", "published", "closed"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "nothing to update");

export const WEB_FORM_AUDIT_SQL = `INSERT INTO audit_log
       (org_id, actor_type, actor_id, action, target_type, target_id, meta)
     VALUES ($1, $2, $3, $4, 'web_form', $5, $6::jsonb)`;

/**
 * A form's source follows its form.
 *
 * `published` -> `active`, anything else -> `paused`. This is not bookkeeping:
 * 0078's `screen()` refuses an arrival on a non-active source and RECORDS the
 * refusal in `lead_intake_events` with a reason a tenant can read. So a direct
 * POST to a closed form's intake token - from a third-party form somebody
 * wired to the same source, or a cached page - lands in the ledger saying "this
 * source is paused" instead of quietly creating leads for a form the tenant
 * believes they closed.
 */
function sourceStatusFor(status: string): "active" | "paused" {
  return status === "published" ? "active" : "paused";
}

@Controller("web-forms")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class WebFormsController {
  constructor(
    private readonly db: DbService,
    private readonly forms: WebFormsService,
  ) {}

  /** Every form this tenant has, published first, newest first. */
  @Get()
  @RequireCrmPermission("web_form", "view")
  async list(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    // The same answer DncController gives, for the same reason: `view` reaches
    // every role and `create`/`edit` reach three, so a console that inferred
    // the second from the persona would render a Create button that 403s on
    // press. An operator on the admin key has no row in the grid and already
    // passed the guard, so they are able.
    const actor = auditActor(req);
    const userId = actor.type === "user" ? actor.id : null;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<WebFormRow>(
        `SELECT ${WEB_FORM_COLUMNS} ${WEB_FORM_FROM}
          ORDER BY (w.status = 'published') DESC, w.created_at DESC`,
      );
      const can = userId
        ? {
            create: await hasCrmGrant(client, orgId, userId, "web_form", "create"),
            edit: await hasCrmGrant(client, orgId, userId, "web_form", "edit"),
          }
        : { create: true, edit: true };
      return { forms: rows.map(webFormDto), can };
    });
  }

  @Get(":id")
  @RequireCrmPermission("web_form", "view")
  async read(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => webFormDto(await this.load(client, id)));
  }

  /**
   * A new form, and the `lead_sources` row it cannot exist without.
   *
   * Both in ONE transaction, which is what makes 0161's `source_id NOT NULL`
   * an invariant rather than an aspiration: there is no window in which a form
   * row exists with no source, and no way to produce one by killing the
   * process halfway.
   *
   * Created as a DRAFT whatever else is sent. A form is published by a
   * deliberate PATCH, which is the call that runs `assertPublishable` - so
   * "created and immediately live with no fields" is not reachable.
   */
  @Post()
  @RequireCrmPermission("web_form", "create")
  async create(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = CreateForm.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      await this.forms.validateFieldMap(client, input.definition, input.fieldMap);

      const sourceName = await this.forms.freeSourceName(client, input.name);
      const {
        rows: [source],
      } = await client.query<{ id: string }>(
        `INSERT INTO lead_sources
           (org_id, workspace_id, kind, name, provider, intake_token, config, status)
         VALUES ($1, $2, 'web_form', $3, 'generic', $4, $5::jsonb, 'paused')
         RETURNING id`,
        // 'paused' to match the draft the form starts as - see sourceStatusFor.
        [orgId, input.workspaceId ?? null, sourceName, generateIntakeToken(), JSON.stringify(this.forms.sourceConfig())],
      );

      const created = await this.forms.insertWithFreeSlug(client, {
        orgId,
        sourceId: source.id,
        name: input.name,
        slug: input.slug ?? null,
        definition: input.definition,
        fieldMap: input.fieldMap,
        consentRequired: input.consentRequired,
        consentText: input.consentText ?? (input.consentRequired ? WEB_FORM_DEFAULT_CONSENT_TEXT : null),
        theme: input.theme,
        redirectUrl: input.redirectUrl ?? null,
        thankYouText: input.thankYouText ?? null,
        createdBy: actor.type === "user" ? actor.id : null,
      });

      await client.query(WEB_FORM_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "web_form.create",
        created.id,
        JSON.stringify({ slug: created.slug, sourceId: source.id }),
      ]);

      return webFormDto(await this.load(client, created.id));
    });
  }

  /**
   * Change a form.
   *
   * ── THE SLUG MOVES ONLY WHILE IT IS A DRAFT ────────────────────────────────
   *
   * A published form's address is in circulation the moment somebody copies
   * it, and this product has no redirect table. Letting the slug change after
   * publication would silently 404 a link in an email signature, a Google Ads
   * destination and a printed card at once, and nothing in the console would
   * say it had happened. Draft is the window; after that the answer is a new
   * form.
   */
  @Patch(":id")
  @RequireCrmPermission("web_form", "edit")
  async update(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = PatchForm.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const current = webFormDto(await this.load(client, id));
      const status = input.status ?? current.status;

      if (input.slug !== undefined && input.slug !== current.slug && current.status !== "draft") {
        throw new BadRequestException(
          "a published form's web address cannot change - the link is already in circulation. " +
            "Close this one and build a new form if the address has to move.",
        );
      }

      const definition = input.definition ?? current.definition;
      const fieldMap = input.fieldMap ?? current.fieldMap;
      // Re-validated on EVERY save, not only when the map is the thing that
      // changed: the custom field it points at can be archived between two
      // saves, and §15 wants that surfaced as a broken form.
      await this.forms.validateFieldMap(client, definition, fieldMap);
      if (status === "published") this.forms.assertPublishable(definition, fieldMap);

      const consentRequired = input.consentRequired ?? current.consentRequired;
      const consentText =
        input.consentText !== undefined
          ? input.consentText
          : current.consentText ?? (consentRequired ? WEB_FORM_DEFAULT_CONSENT_TEXT : null);

      const update = () =>
        client.query<{ slug: string }>(
          `UPDATE web_forms
            SET name = $2, slug = $3, definition = $4::jsonb, field_map = $5::jsonb,
                consent_required = $6, consent_text = $7, theme = $8::jsonb,
                redirect_url = $9, thank_you_text = $10, status = $11
          WHERE id = $1
          RETURNING slug`,
          [
            id,
            input.name ?? current.name,
            input.slug ?? current.slug,
            JSON.stringify(definition),
            JSON.stringify(fieldMap),
            consentRequired,
            consentRequired ? consentText || WEB_FORM_DEFAULT_CONSENT_TEXT : consentText,
            JSON.stringify(input.theme ?? current.theme),
            input.redirectUrl !== undefined ? input.redirectUrl : current.redirectUrl,
            input.thankYouText !== undefined ? input.thankYouText : current.thankYouText,
            status,
          ],
        );

      /**
       * A chosen slug can collide with a form in ANOTHER tenant, and RLS means
       * no SELECT here can see it - the collision only surfaces as 23505 off
       * `web_forms_slug_global`. Left alone that is a 500 on a name clash.
       *
       * The message says the address is taken and NOT who has it, which is
       * the whole reason the create path appends a random suffix rather than a
       * counter: a shared namespace must not become a directory of other
       * tenants' forms.
       */
      let row: { slug: string } | undefined;
      try {
        row = (await update()).rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new BadRequestException("that web address is already taken - choose another");
        }
        throw err;
      }
      if (!row) throw new NotFoundException("no such form");

      if (status !== current.status) {
        await client.query(`UPDATE lead_sources SET status = $2 WHERE id = $1`, [
          current.sourceId,
          sourceStatusFor(status),
        ]);
      }

      await client.query(WEB_FORM_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        status !== current.status ? `web_form.${status}` : "web_form.update",
        id,
        JSON.stringify({ slug: row.slug, from: current.status, to: status }),
      ]);

      return webFormDto(await this.load(client, id));
    });
  }

  /** Inside `withOrg`, so another tenant's id is simply not found. */
  private async load(client: PoolClient, id: string): Promise<WebFormRow> {
    const {
      rows: [row],
    } = await client.query<WebFormRow>(`SELECT ${WEB_FORM_COLUMNS} ${WEB_FORM_FROM} WHERE w.id = $1`, [id]);
    if (!row) throw new NotFoundException("no such form");
    return row;
  }
}
