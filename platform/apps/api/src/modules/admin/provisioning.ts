import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { isRootOperator } from "../../common/operator-scope";
import {
  DEFAULT_PIPELINE_STAGES,
  type OrgModule,
  PermissionObjectType,
  type WhatsAppProvider,
} from "@aura/shared";

/**
 * THE ONE WAY A TENANT COMES INTO EXISTENCE.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 *
 * This body used to live inline in `AdminController.createTenant`, where it had
 * exactly one caller. Self-serve signup is the second one, and a second caller
 * is precisely the condition under which an inline provisioning body becomes
 * dangerous: the natural way to write the new path is to copy the INSERTs that
 * matter and leave behind the seeding that does not look load-bearing.
 *
 * It is load-bearing. `seedRoleDefaults` is the whole permission grid, and an
 * org without it 403s on EVERY gated route for every real user - and cannot be
 * repaired from its own console, because managing roles needs the grid that is
 * missing. That is not hypothetical: the API-only tier (0192) was the first
 * tenant shape with no CRM, and it provisioned with zero roles and zero grants
 * for exactly this reason, because the seeding was hiding inside the CRM path.
 *
 * So there is one function, both callers use it, and a tenant created by a
 * stranger's payment is structurally identical to one an operator made.
 *
 * ── THE CALLER OWNS THE TRANSACTION ─────────────────────────────────────────
 *
 * `provisionTenant` takes a `PoolClient` already inside a transaction rather
 * than opening its own. The signup path has to provision the org, issue the
 * claim invite and settle the order as ONE atomic unit - a half-provisioned org
 * with a paid order against it is the single worst state this system can reach,
 * because the buyer has been charged and there is no operator watching. Letting
 * this function own a transaction would make that atomicity impossible.
 *
 * It must run on the ADMIN pool: the org does not exist yet, so there is no
 * `app.org_id` for `withOrg` to scope to.
 */

/** The 5 system roles seeded for every org - mirrors migration 0039's own seed. */
export const SYSTEM_ROLES = [
  { key: "platform_admin", name: "Platform Admin" },
  { key: "org_admin", name: "Org Admin" },
  { key: "workspace_admin", name: "Workspace Admin" },
  { key: "workspace_member", name: "Workspace Member" },
  { key: "viewer", name: "Viewer" },
] as const;

/**
 * Give an org the 5 system roles with a full permission grid across every
 * `PermissionObjectType` - what migrations 0039/0041/0055/0059/0060
 * one-time-backfilled for orgs that already existed when each of them ran.
 *
 * Runs on EVERY provisioning path, not only CRM ones, and that is the whole
 * point of it being its own function. The grid is what `PermissionsGuard` and
 * `CrmPermissionsGuard` join against, and it governs far more than CRM
 * objects - leads, tasks, lead boards, resources, appointments. An org with no
 * `roles` rows therefore gets a 403 on every permission-gated route for every
 * real user, and the owner cannot repair it from the console, because managing
 * roles needs the grid that is missing.
 *
 * This used to live inside `seedCrmDefaults` and so ran only when 'crm' was
 * being turned on. That was invisible while every tenant had the CRM. The
 * API-only tier (`aura, api_insights`, migration 0192) is the first shape of
 * tenant that has none, and it provisioned with zero roles and zero grants.
 *
 * Object types are read from the shared `PermissionObjectType` enum rather
 * than hardcoded, so a future object type that widens that enum is seeded
 * here automatically instead of needing another one-time migration backfill.
 *
 * Idempotent by convention, not by construction: callers only invoke this
 * when `roles` has zero rows for the org, so provisioning a module twice
 * never double-inserts.
 */
export async function seedRoleDefaults(client: PoolClient, orgId: string): Promise<void> {
  await client.query(
    `INSERT INTO roles (org_id, key, name, is_system)
     SELECT $1, v.key, v.name, true
       FROM (VALUES ${SYSTEM_ROLES.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`).join(", ")})
         AS v(key, name)`,
    [orgId, ...SYSTEM_ROLES.flatMap((r) => [r.key, r.name])],
  );

  await client.query(
    `INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
     SELECT r.org_id, r.id, ot.object_type, a.action, 'all'
       FROM roles r
       CROSS JOIN unnest($2::text[]) AS ot(object_type)
       CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('export')) AS a(action)
      WHERE r.org_id = $1
        AND r.is_system
        AND (
          r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
          -- Reshaping or deleting a lead board is an administrator's call, not
          -- a telecaller's (migration 0136 applies the same split to existing orgs).
          OR (r.key = 'workspace_member' AND a.action IN ('view', 'create', 'edit')
              AND ot.object_type <> 'lead_board')
          OR (r.key = 'viewer' AND a.action = 'view')
        )`,
    [orgId, PermissionObjectType.options],
  );
}

/**
 * The CRM half of provisioning: the default deal pipeline that migrations
 * 0034/0075 backfilled. Called only when the 'crm' module is being turned on
 * (createTenant's `enableCrm` flag, or `PATCH tenants/:orgId/modules`).
 *
 * Without it, an org with 'crm' enabled but never seeded gets zero CRM
 * projection from calls (apps/worker/src/pipeline/pipeline.ts's "no default
 * pipeline for org" - deals.controller.ts's resolvePipeline() throws the same
 * way on an explicit create).
 *
 * The roles and the grid are NOT here - see `seedRoleDefaults`, which every
 * tenant gets whether or not it has the CRM.
 */
export async function seedCrmDefaults(client: PoolClient, orgId: string): Promise<void> {
  // FIND-or-create, not a bare INSERT.
  //
  // seedBoardDefaults (below) runs on every provisioning path and already
  // find-or-creates the org's default pipeline, because boards.pipeline_id is
  // NOT NULL. An unguarded INSERT here would therefore add a SECOND pipeline
  // with is_default = true - and "exactly one default per org" is only
  // app-enforced (0034 says so), so nothing in the database would stop it. The
  // same collision is reachable without boards at all: migration 0075 seeds a
  // pipeline for every org, so enabling 'crm' on a tenant created before this
  // change would double up too.
  //
  // One pipeline, shared by the board and the CRM, is also the correct
  // outcome: the board's deal_stage_key bridge points at that pipeline's
  // stages, and a second competing default is exactly the split B2's bug is.
  await client.query(
    `INSERT INTO deal_pipelines (org_id, name, stages, is_default)
     SELECT $1, 'Sales Pipeline', $2::jsonb, true
      WHERE NOT EXISTS (
        SELECT 1 FROM deal_pipelines p WHERE p.org_id = $1 AND p.status = 'active')`,
    [orgId, JSON.stringify(DEFAULT_PIPELINE_STAGES)],
  );
}

/**
 * Give an org the editable board every other org has (migration 0075).
 *
 * Delegates to the `seed_default_board(uuid)` SQL function rather than
 * reimplementing it here, and that is deliberate: 0075's own backfill calls
 * the SAME function for the orgs that already existed, so a CRM provisioned
 * from the admin dashboard today is structurally identical to one that
 * predates the migration. A TypeScript copy of that SQL would drift the first
 * time either side was edited, and the failure mode is a tenant whose board
 * quietly differs from every other tenant's - invisible until someone tries to
 * reshape it.
 *
 * Idempotent by CONSTRUCTION, not by convention (unlike seedCrmDefaults): the
 * function returns the existing default board untouched if there is one, so
 * every caller may invoke it unconditionally.
 *
 * Runs for EVERY tenant, not only CRM ones. `/owner/board` is the leads board
 * and every org has leads; `enabled_modules` is what gates CRM access, not the
 * presence of seeded rows - the same reasoning updateModules already applies
 * when it declines to delete anything on module removal.
 */
export async function seedBoardDefaults(client: PoolClient, orgId: string): Promise<void> {
  await client.query(`SELECT seed_default_board($1)`, [orgId]);
}

/**
 * WHO ONBOARDED THIS CLIENT (doc 49 P13b, migration 0206).
 *
 * The shape mirrors 0206's consistency CHECK exactly, so a value that type-checks
 * is a value the database will accept. The three legal states, and nothing else:
 *
 *   - an operator did it, and is named;
 *   - nobody did it - the buyer provisioned themselves;
 *   - it is not on the record, which is every tenant predating 0206 and any
 *     tenant a script creates with the bare admin key.
 *
 * The third state is NOT a failure. `operatorOrgScope` treats an unattributed
 * client as root-only, so the absence of a record is conservative rather than
 * permissive - which is the whole reason it is allowed to exist instead of being
 * guessed at.
 */
export type OnboardingAttribution =
  | { role: "root" | "superadmin"; operator: string }
  | { role: "self_serve"; operator: null }
  | { role: null; operator: null };

/** Nothing on the record. See OnboardingAttribution's third state. */
export const UNATTRIBUTED: OnboardingAttribution = { role: null, operator: null };

/**
 * The attribution implied by an audit actor.
 *
 * Only an `operator` actor can be attributed, and whether that operator is the
 * ROOT is decided here against the environment - never taken from a caller and
 * never read from `platform_operators`, for 0089's reason, which 0206's header
 * restates.
 *
 * Every other actor shape resolves to UNATTRIBUTED rather than to a guess. In
 * particular a `system` actor does NOT become 'self_serve': the signup path says
 * so explicitly, and a script holding the admin key is a different thing wearing
 * the same actor type. Inferring one from the other would write a false
 * provenance record, which is worse than an honest blank.
 */
export function onboardingFromActor(actor: ProvisionActor): OnboardingAttribution {
  if (actor.type !== "operator") return UNATTRIBUTED;
  const email = actor.id.trim().toLowerCase();
  if (!email) return UNATTRIBUTED;
  return { role: isRootOperator(email) ? "root" : "superadmin", operator: email };
}

/** What a caller must decide before an org can exist. */
export interface ProvisionTenantInput {
  name: string;
  workspaceName: string;
  /** Explicit module list. 'aura' is forced in regardless - see below. */
  modules?: OrgModule[];
  /** Shorthand for `modules: ['aura', 'crm']`. Ignored when `modules` is given. */
  enableCrm?: boolean;
  consentPolicy?: string | null;
  retentionDays?: number | null;
  region?: string | null;
  whatsappProvider?: WhatsAppProvider;
  tokenTtlMinutes: number;
  tokenMaxUses: number;
  /**
   * Who onboarded this client. REQUIRED, and deliberately not defaulted: a
   * default would mean the third caller of this function silently creates an
   * unattributed tenant, and an unattributed tenant is invisible to every
   * superadmin. Pass UNATTRIBUTED to say so on purpose.
   */
  onboarding: OnboardingAttribution;
}

/** Who to name in the audit row. */
export interface ProvisionActor {
  id: string;
  type: string;
}

export interface ProvisionedTenant {
  org: Record<string, unknown> & { id: string };
  workspace: { id: string; name: string };
  instance: Record<string, unknown> & { id: string };
  enrollment: {
    orgId: string;
    instanceId: string;
    /** Shown once, never retrievable again - only the hash is stored. */
    adminKey: string;
    expiresAt: string;
    maxUses: number;
  };
}

/**
 * Provision a customer: organization (the RLS boundary) + default workspace +
 * first instance + its one-time enrollment key.
 *
 * `client` MUST already be inside a transaction on the admin pool. This
 * function neither begins nor commits one - see the module header.
 */
export async function provisionTenant(
  client: PoolClient,
  input: ProvisionTenantInput,
  actor: ProvisionActor,
): Promise<ProvisionedTenant> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  // An explicit `modules` list wins over the `enableCrm` shorthand; 'aura' is
  // forced in either way, because every tenant created here is given an
  // instance, a workspace and devices, so an org without it would be
  // describing itself falsely from its first second.
  const modules: OrgModule[] = input.modules
    ? Array.from(new Set<OrgModule>(["aura", ...input.modules]))
    : input.enableCrm
      ? ["aura", "crm"]
      : ["aura"];

  const whatsappProvider = input.whatsappProvider ?? "none";

  const {
    rows: [org],
  } = await client.query(
    // Both attribution parameters are cast. They are the only two nullable
    // text parameters here, and an uncast NULL text leaves Postgres unable to
    // determine the parameter's type at PREPARE - a 42P08 that names the
    // parameter number and nothing else. This codebase has lost a day to that
    // exact error four times; see `audit_log`'s own note.
    `INSERT INTO organizations (name, consent_policy, retention_days, region,
                                enabled_modules, whatsapp_provider,
                                onboarded_by_operator, onboarded_by_role, onboarded_at)
     VALUES ($1,
             COALESCE($2, 'tone'),
             COALESCE($3, 90),
             COALESCE($4, 'ap-south-1'),
             $5, $6,
             $7::text, $8::text,
             -- Only a client that IS attributed gets a time of attribution. An
             -- unattributed row carrying a timestamp would read as "onboarded
             -- by somebody at 14:03", which is the opposite of what it means.
             CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
     RETURNING id, name, status, consent_policy, retention_days, region,
               enabled_modules, whatsapp_provider, created_at,
               onboarded_by_operator, onboarded_by_role, onboarded_at`,
    [
      input.name,
      input.consentPolicy ?? null,
      input.retentionDays ?? null,
      input.region ?? null,
      modules,
      whatsappProvider,
      input.onboarding.operator,
      input.onboarding.role,
    ],
  );

  // Board first: it find-or-creates the org's one default pipeline, which
  // seedCrmDefaults then reuses rather than competing with.
  await seedBoardDefaults(client, org.id);
  // Unconditional: the permission grid is not a CRM thing. See
  // seedRoleDefaults - an org without it 403s on every gated route and
  // cannot be repaired from its own console.
  await seedRoleDefaults(client, org.id);
  if (modules.includes("crm")) await seedCrmDefaults(client, org.id);

  const {
    rows: [workspace],
  } = await client.query(
    `INSERT INTO workspaces (org_id, name) VALUES ($1, $2) RETURNING id, name`,
    [org.id, input.workspaceName],
  );

  const {
    rows: [instance],
  } = await client.query(
    `INSERT INTO instances (org_id, workspace_id, name)
     VALUES ($1, $2, $3)
     RETURNING id, name, config_version, created_at`,
    [org.id, workspace.id, input.name],
  );

  const {
    rows: [token],
  } = await client.query(
    `INSERT INTO enrollment_tokens (org_id, instance_id, token_hash, expires_at, max_uses)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5)
     RETURNING id, expires_at, max_uses`,
    [org.id, instance.id, tokenHash, input.tokenTtlMinutes, input.tokenMaxUses],
  );

  await client.query(
    `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
     VALUES ($1, $4, $2, 'tenant.create', 'organization', $3)`,
    [org.id, actor.id, org.id, actor.type],
  );

  return {
    org,
    workspace,
    instance,
    enrollment: {
      orgId: org.id,
      instanceId: instance.id,
      adminKey: rawToken,
      expiresAt: token.expires_at,
      maxUses: token.max_uses,
    },
  };
}
