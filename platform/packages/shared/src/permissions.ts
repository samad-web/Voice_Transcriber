import { z } from "zod";
// `PERMISSION_OBJECT_MODULE` is typed as a full `OrgModule` record since the
// finance module landed, so a module added to the catalogue without deciding
// which objects it gates is a type error rather than a runtime 403.
import type { OrgModule } from "./org-modules";

/**
 * The role -> object -> action(+scope/field) permission model
 * (packages/db/migrations/0039), layered ALONGSIDE - not replacing -
 * memberships.role (operator RBAC) and memberships.owner_role (console
 * persona, see roles.ts).
 *
 * NO LONGER SCHEMA-ONLY, and this header used to say it was. `CrmPermissions
 * Guard` has enforced the grid since 0079, and `PUT /v1/owner/team/:userId/role`
 * (0102) assigns it - so both halves of 0039's deferral are closed. What is
 * still true is the reason it was deferred: `memberships.role` remains the
 * five-value CHECK enum every authorization call site reads, and nothing here
 * writes it.
 *
 * The three axes, and all three must say yes:
 *   memberships.role        the tenant tier - API keys, consent policy, erasure.
 *   memberships.owner_role  the console persona - which console, whose records.
 *   role_permissions        this grid - what may be done with a record.
 */

/** The 5 system roles seeded for every org - mirrors memberships.role's CHECK. */
export const SystemRoleKey = z.enum([
  "platform_admin",
  "org_admin",
  "workspace_admin",
  "workspace_member",
  "viewer",
]);
export type SystemRoleKey = z.infer<typeof SystemRoleKey>;

/**
 * What a grant can be about. `task` joined in with Track A3 (migration 0041),
 * which also seeds every system role's task grants to match its contact ones -
 * widening this enum without that seeding would lock every existing user out
 * of the new object, since CrmPermissionsGuard denies whatever it finds no
 * grant for.
 *
 * Still absent, deliberately: `pipeline`, `custom_field` and `merge`. Those
 * are org-configuration surfaces rather than records, and they stay on
 * AdminKeyGuard+TenantGuard until there is a reason to model them here.
 *
 * `product`/`quotation`/`invoice` joined in with the Kailash-gap Milestone 1
 * work (migrations 0059/0060), seeded the same way `task` and `conversation`
 * were - every system role gets a matching grant in the same migration that
 * widens this enum, so nobody is locked out the day it ships.
 *
 * `lead` joined in with 0103, and it is the first entry here that is NOT a CRM
 * object. Until then this grid governed the CRM half of the console and
 * nothing else: the lead board and the full lead list - the pages an Aura
 * tenant actually spends the day in - were gated by the console PERSONA alone,
 * so an owner could rearrange forty checkboxes and change nothing about them.
 * See `PERMISSION_OBJECT_MODULE` below for what widening it required.
 *
 * `lead_board` joined in with 0136: making, reshaping, routing and deleting
 * lead boards. Like `pipeline` it is configuration rather than a record, but
 * unlike `pipeline` an owner asked to decide per role who may do it, so it is
 * modelled here. Only `all` scope is meaningful - the console shows its cells
 * as No / Yes.
 *
 * `call` is deliberately still ABSENT, and that is a decision rather than an
 * omission. Reading a call already has three gates - the `call_intel` module,
 * the `recordings_listen` flag on the membership, and the persona - and 0039's
 * own header ruled the recordings mechanism out of scope for exactly this
 * reason. A fourth axis over one object is how "why can Priya not hear this
 * call" acquires four possible answers and no one of them is authoritative.
 *
 * `contact_number` and `dnc` joined in with the P0 foundations of doc 39, and
 * they belong here for exactly the reason `pipeline` does not. A number in the
 * vault and a suppression list are per-record DATA a role may or may not be
 * trusted with, not org configuration: revealing a customer's real phone
 * number is the most sensitive single read in the product, and a do-not-call
 * list is the standing record of who asked to be left alone. Neither is a
 * shape somebody configures once, the way a pipeline's stages or a custom
 * field's definition are - which is what keeps those on AdminKeyGuard and
 * these here.
 *
 * `contact_number` carries `view` ALONE, because there is exactly one route
 * that discloses an `e164` to a human (doc 39 §2.1) and nothing else to gate:
 * the vault is written by intake, not by hand, and the handset's own dialer
 * fetch authenticates as a device rather than as a role. `dnc` carries
 * `view`/`create`/`edit` - read the lists, upload one, disable one. No
 * `delete`: a list is disabled, never deleted, so a delete cell would be a
 * checkbox with no route behind it.
 *
 * Migration 0158 seeds every system role's grants for BOTH objects, in the
 * same file that widens this enum. That is not tidiness. Widening this enum
 * without seeding LOCKS EVERY USER OUT of the new object, because
 * `CrmPermissionsGuard` denies whatever it finds no grant for - the lesson
 * 0041, 0059/0060 and 0103 each record above, learned once per object because
 * the enum is the easy half and the seeding is the half that is forgotten.
 */
export const PermissionObjectType = z.enum([
  "contact",
  "account",
  "deal",
  "task",
  "conversation",
  "product",
  "quotation",
  "invoice",
  "lead",
  "lead_board",
  "contact_number",
  "dnc",
  // Doc 39 P1-P6. Added ahead of their controllers so five phases can be built
  // in parallel without each one editing this file - the matching
  // ENFORCED_PERMISSIONS strings are added as each controller lands, because
  // permissions-inventory.spec.ts asserts that list equals what controllers
  // actually declare. Each phase's own migration seeds every system role's
  // grants, which is the step that must never be skipped: CrmPermissionsGuard
  // denies whatever it finds no grant for, so widening this enum without
  // seeding locks every user out of the new object on deploy day.
  "dial_campaign",
  "web_form",
  "partner",
  "resource",
  "appointment",
  /**
   * `callback` - the managed to-call list (Build docs/transcript-agent-build-
   * plan §10A, migration 0186).
   *
   * NOT folded into `task`, although a callback and a follow-up look alike.
   * §10A.9 requires "telecallers see only their own list", and the two objects
   * need DIFFERENT answers to "who may reassign": a telecaller may complete
   * and snooze their own callbacks and may not hand one to somebody else,
   * whereas task assignment has its own `task:assign_up` mechanism (0141).
   * One object with one grant cannot express both.
   *
   * Deliberately NOT in `ALL_SCOPE_ONLY_OBJECTS`: `owned` is the MOST
   * meaningful scope here - the entire product is "a telecaller's own list" -
   * so it carries a real owner column (`callbacks.assigned_user_id`, wired in
   * crm-scope.ts), exactly as `appointment` does.
   *
   * No `delete`. A callback is CANCELLED, never deleted: it is the record of a
   * promise the business made to a person, and a delete cell would be a way to
   * make that record disappear. Same reasoning 0158 gives for `dnc`.
   */
  "callback",
  /**
   * The finance module (Build docs/finance-section-build-plan §3, migration
   * 0172). TWO objects, and the split is the one §3's role table actually
   * needs:
   *
   * `finance` is the back office - the canonical payment record, the ledger,
   * the matching queue, expenses, deal templates and payment schedules,
   * periods. Whole-org data with no per-record owner, so it is in
   * `ALL_SCOPE_ONLY_OBJECTS`. "Finance handler" is not a persona here (adding
   * one would be fail-open during a rolling deploy - see roles.ts); it is
   * whoever holds `finance:edit`, which is what DECISIONS.md §3.3 records.
   *
   * `incentive` is somebody's PAY, and it is the reason these are two objects
   * rather than one. §3 is explicit: "a telecaller must never be able to read
   * another telecaller's pay or incentive, even by guessing an ID." That is a
   * row filter, not a yes/no - so `incentive` carries a real owner column
   * (`incentive_payouts.user_id`, wired in crm-scope.ts) and a telecaller gets
   * `view` at `owned` scope. Folding it into `finance` would have made the
   * only available answer "all the floor's pay or none of it".
   *
   * Connector CREDENTIALS are deliberately not modelled here. §3 says the
   * finance handler gets everything except connector secrets, and a grid cell
   * that can be ticked is the wrong shape for "nobody but the owner, ever" -
   * those routes carry `OwnerRoleGuard` instead.
   *
   * Migration 0172 seeds every system role's grants for both objects in the
   * same file that widens this enum. That step is not tidiness: the guard
   * denies whatever it finds no grant for, so widening without seeding locks
   * EVERY user out of the new object on deploy day - the lesson 0041,
   * 0059/0060, 0103 and 0158 each record above.
   */
  "finance",
  "incentive",
  /**
   * The organization chart (Build docs/org-chart-build-plan.md, migrations
   * 0177/0178). TWO objects, and the split is the one §7's role table forces.
   *
   * `position` is the chart itself - seats, reporting lines, who holds what,
   * responsibilities and the decision-authority table. §7 gives a telecaller
   * all of it ("see the chart, names, titles, departments, responsibilities
   * and authority"), because the module's reason to exist is a new joiner
   * finding out who to ask. It is in `ALL_SCOPE_ONLY_OBJECTS`: a seat is not
   * owned by whoever sits in it, and "my own position" would have to mean "the
   * one node I hold", which is not a chart.
   *
   * `employment_contract` is somebody's PAY, their notice period and their
   * signed paperwork, and it is a second object because §7 is explicit that
   * staff cannot see any of it while they must KEEP the chart. M7's acceptance
   * criterion is a negative API test, and one object covering both would make
   * that unsatisfiable: a telecaller needs `position:view` to use the console
   * at all.
   *
   * `employment_contract` is deliberately NOT in `ALL_SCOPE_ONLY_OBJECTS`, and
   * it is the most meaningful `owned` scope in this enum - its owner column is
   * `employment_contracts.user_id`, so an org that wants people to read their
   * OWN contract grants `view` at `owned` and gets exactly that, as a WHERE
   * clause. 0178 does not seed it that way; §7's default is that staff see
   * nothing here. The column exists so the choice is a row filter rather than
   * a checkbox that silently matches everything.
   *
   * §7's "HR / finance handler" is not a persona, for the reason `finance`
   * above is not either: a fourth `owner_role` is fail-open during a rolling
   * deploy (see roles.ts). The handler is whoever holds
   * `employment_contract:edit`.
   *
   * Migrations 0177 and 0178 seed every system role's grants in the same files
   * that widen this enum - 0177 five roles for `position:view`, 0178 three
   * roles and no more. Widening without seeding locks EVERY user out of the
   * new object on deploy day, which is the lesson 0041, 0059/0060, 0103, 0158
   * and 0165 each record above.
   */
  "position",
  "employment_contract",
]);
export type PermissionObjectType = z.infer<typeof PermissionObjectType>;

/**
 * The product module each object needs (migration 0072's `enabled_modules`).
 *
 * ── WHY THIS HAD TO EXIST BEFORE `lead` COULD ───────────────────────────────
 *
 * `CrmPermissionsGuard` used to hard-code `'crm' = ANY(enabled_modules)` in its
 * lookup, which was right while every object in this enum was a CRM object: a
 * tenant with the CRM switched off should be denied exactly as if the grant
 * were missing, or their leftover `role_permissions` rows would keep granting
 * access to a module they no longer have.
 *
 * `lead` is core Aura. Leaving the module hard-coded would have taken the lead
 * board away from every recording-only tenant the moment the guard was mounted
 * on it - the single most damaging regression this change could have shipped.
 * So the requirement now comes from the object.
 */
export const PERMISSION_OBJECT_MODULE: Record<PermissionObjectType, OrgModule> = {
  contact: "crm",
  account: "crm",
  deal: "crm",
  task: "crm",
  conversation: "crm",
  product: "crm",
  quotation: "crm",
  invoice: "crm",
  lead: "aura",
  lead_board: "aura",
  // Both `aura`, and for the same reason `lead` is. The number vault and the
  // suppression lists exist to make a phone ring, which is the recorder
  // product - a tenant with no CRM still dials, still reveals a number and
  // still owes the people on a do-not-call list. Filing either under `crm`
  // would have the guard deny both to every recorder-only tenant.
  contact_number: "aura",
  dnc: "aura",
  // `aura`, with the same test applied: does a tenant with no CRM still do
  // this? A recorder-only tenant dials, captures leads from a form, and can
  // have brokers feeding it leads - all of which work on `leads`, which is
  // itself `aura`. Filing any of these under `crm` would 403 every request
  // from a tenant whose leads work perfectly.
  dial_campaign: "aura",
  web_form: "aura",
  partner: "aura",
  // `crm`, and these two genuinely are. A resource hangs off projects, deals
  // and quotations, and an appointment is a CRM record with an assignee - a
  // recorder-only tenant has no inventory and no diary to put them in. Doc 39
  // §26.4 gates all four vertical primitives on `crm` for this reason.
  resource: "crm",
  appointment: "crm",
  /**
   * `call_intel`, and NOT `aura` or `crm`.
   *
   * The same test the entries above apply - does a tenant without the module
   * still do this? - and the answer is genuinely no. A callback exists because
   * the assistant read a transcript, and `call_intel` is what decides whether a
   * tenant may have their calls read at all (`org-modules.ts`: "who may read a
   * word-for-word account of a customer's phone call is a decision per client
   * contract"). A recorder-only tenant without `call_intel` has no transcripts
   * being understood, so it has no callbacks - and filing this under `aura`
   * would offer the page to every such tenant with nothing ever in it.
   *
   * A callback created BY HAND from the console is the edge this excludes, and
   * it is excluded knowingly: that is what `tasks` is for, and 0134's
   * missed-call path already creates one.
   */
  callback: "call_intel",
  // The widening that made this a full `OrgModule` record rather than
  // `"aura" | "crm"`. Both are `finance`, which is the point: a tenant who has
  // not bought the back office is denied the ledger and the payout screens
  // exactly as if the grant were missing, and a tenant who had it and gave it
  // up stops being granted them by the `role_permissions` rows they keep.
  //
  // NOT `crm`, even though a deal is a CRM record: filing them there would
  // hand every existing CRM tenant a finance module they never bought the day
  // this deploys, which is the mirror image of the mistake `lead` avoided.
  finance: "finance",
  incentive: "finance",
  /**
   * Both `aura`, and the `lead` test is what decides it: does a tenant with no
   * CRM still do this? A recorder-only tenant has staff, a manager, a reporting
   * line and employment contracts - every business does, whether or not it
   * bought a pipeline. Filing either under `crm` would 403 every request from a
   * tenant whose team is perfectly real, and filing them under a new
   * `org_chart` module would hand the same tenants a chart they cannot open.
   *
   * Whether a client WANTS the page is a separate question, answered on the
   * other provisioning axis: `org_chart` is a FeatureKey (0093's
   * `org_feature_settings`), which is visibility rather than security. A module
   * is for something separately sold; a feature is for something a business
   * switches off. This is the second.
   */
  position: "aura",
  employment_contract: "aura",
};

/** Objects whose grants are whole-org powers, where "own records" means nothing. */
export const ALL_SCOPE_ONLY_OBJECTS: ReadonlySet<PermissionObjectType> = new Set([
  "lead_board",
  // Both joined with 0157/0158 for the same reason `lead_board` is here: there
  // is no such thing as "my own" one of these. A suppression list is a
  // whole-org obligation - the people on it are owed silence by everybody, not
  // by whoever uploaded the sheet - and a vault row is a property of a phone
  // number, not of a user. Offering an all/owned picker for either would let an
  // admin save an `owned` grant that silently matches nothing, which is worse
  // than not offering the choice: the role would look configured and behave as
  // though it had no grant at all.
  "contact_number",
  "dnc",
  // Whole-org powers, same as `lead_board`: a campaign, a public form, the
  // partner roster and a unit of inventory have no owner, so "my own" means
  // nothing for any of them.
  "dial_campaign",
  "web_form",
  "partner",
  "resource",
  // A ledger entry, a payment and an expense have no owner - "my own payment"
  // means nothing, and the finance back office is a whole-org function by
  // definition. An `owned` grant here would match nothing while looking
  // configured, which is worse than not offering the choice.
  //
  // `incentive` is deliberately NOT here, for the same reason `appointment` is
  // not: `owned` is the MOST meaningful scope on it. See the note below.
  "finance",
  /**
   * A SEAT has no owner. "My own position" could only mean "the one node I
   * hold", and a chart narrowed to one node is not a chart - an `owned` grant
   * here would look configured and show somebody nothing.
   *
   * §7's "Manager: view their branch in detail" is a SUBTREE, which all/owned
   * cannot express at all. It is enforced in the controller against the
   * reporting tree instead; ORG_CHART_DECISIONS.md §4 records why that is not
   * folded in here as a third scope value.
   *
   * `employment_contract` is deliberately NOT here - see the enum above. It is
   * the clearest `owned` case in the whole grid.
   */
  "position",
  // `appointment` is deliberately NOT here. It carries `assigned_user_id`, and
  // "my own appointments" is the most meaningful scope on it - a telecaller
  // seeing their own diary rather than the whole clinic's is exactly what an
  // `owned` grant is for. Its owner column is wired in crm-scope.ts.
]);

/**
 * `assign_up` joined with migration 0141 - "may this role hand a task to an
 * owner or manager persona". It is meaningful for `task` only: nothing else in
 * this enum has an upward direction to gate, so every other object's cell is
 * left inert (`ENFORCED_PERMISSIONS` lists only `task:assign_up`) rather than
 * offering a picker that changes nothing.
 *
 * Assignment itself was never gated - `assertMembers` in tasks.controller.ts
 * only checks the assignee is a member of the org, and 0135's accept/decline
 * flow was always the actual safety valve (the assignee can simply decline).
 * This does not replace that; it adds a role-level "no" in front of it for
 * tenants that want one.
 */
export const PermissionAction = z.enum(["view", "create", "edit", "delete", "export", "assign_up"]);
export type PermissionAction = z.infer<typeof PermissionAction>;

export const PermissionScope = z.enum(["all", "owned"]);
export type PermissionScope = z.infer<typeof PermissionScope>;

/**
 * Actions where scope is meaningless - a capability, not a row filter -
 * mirroring `ALL_SCOPE_ONLY_OBJECTS` but per-action rather than per-object.
 * `assign_up` answers "may this role ever do it", never "for which records",
 * so the console renders it Yes/No like a whole-org power.
 */
export const ALL_SCOPE_ONLY_ACTIONS: ReadonlySet<PermissionAction> = new Set(["assign_up"]);

export const FieldRestriction = z.enum(["hidden", "readonly"]);
export type FieldRestriction = z.infer<typeof FieldRestriction>;

/** One row of role_permissions. */
export const RolePermissionGrant = z.object({
  objectType: PermissionObjectType,
  action: PermissionAction,
  scope: PermissionScope.default("all"),
  fieldRestrictions: z.record(z.string(), FieldRestriction).default({}),
});
export type RolePermissionGrant = z.infer<typeof RolePermissionGrant>;

export const RoleInput = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier required")
    .max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});
export type RoleInput = z.infer<typeof RoleInput>;

/**
 * The (object, action) pairs the API ACTUALLY enforces.
 *
 * ── WHY A CONSOLE NEEDS THIS ────────────────────────────────────────────────
 *
 * The grid is a full cross product - nine objects by five actions, forty-five
 * cells - and the API mounts a guard on twenty-seven of them. The other
 * eighteen are checkboxes that change nothing: ticking Export on Contacts, or
 * Delete on Invoices, writes a `role_permissions` row that no route ever reads.
 *
 * A permissions screen that silently ignores half of what you set is worse
 * than one that offers less. Somebody removes Delete from a role, tells their
 * team the records are safe, and they are not. So the console renders the
 * unenforced cells as inert and says so, and this list is where it learns
 * which.
 *
 * ── AND WHY IT IS A LIST RATHER THAN A COMMENT ──────────────────────────────
 *
 * `permissions-inventory.spec.ts` reflects over every controller's real
 * `@RequireCrmPermission` metadata and asserts this list matches it exactly.
 * Mount a guard on a new route and the test fails until the cell is marked
 * live; delete a route and it fails until the cell is marked inert. A hand-
 * maintained list would be wrong within a month and wrong in the direction
 * that over-promises.
 */
export const ENFORCED_PERMISSIONS: ReadonlyArray<`${PermissionObjectType}:${PermissionAction}`> = [
  "account:create",
  "account:edit",
  "account:view",
  // Doc 39 P6. No `appointment:delete` - a booking is cancelled, never
  // removed, so the no-show and attendance history survives it.
  "appointment:create",
  "appointment:edit",
  "appointment:view",
  // §10A.9. No `callback:delete` - a callback is cancelled, never deleted, so
  // the record of a promise the business made survives it. Reassignment is
  // gated on the manager's `all` scope inside the controller rather than on a
  // fourth action, because handing work to another person is a decision about
  // somebody else's day and not a different verb on this record.
  "callback:create",
  "callback:edit",
  "callback:view",
  "contact:create",
  "contact:edit",
  "contact:view",
  // Sorts here, not after "conversation": ":" (0x3A) is below "_" (0x5F), which
  // is the same reason "lead:*" precedes "lead_board:*" below.
  "contact_number:view",
  "conversation:edit",
  "conversation:view",
  "deal:create",
  // No "deal:delete". The decorator exists in crm-permissions.guard.spec.ts as a
  // FIXTURE and nowhere else - a grep over source finds it and reports a delete
  // gate that does not exist. `permissions-inventory.spec.ts` reflects over real
  // controller metadata instead, and caught exactly this on its first run.
  "deal:edit",
  "deal:export",
  "deal:view",
  // Doc 39 P1. Sorts between `deal:*` and `dnc:*`. No `dial_campaign:delete`
  // - a campaign is paused or completed. NOTE: `edit` currently covers both
  // an agent's Skip and a supervisor pausing the floor, which is why 0159
  // seeds it to `workspace_member`; splitting out a `dial_campaign:dial`
  // action is the fix, and a test pins that the two share one action today.
  "dial_campaign:create",
  "dial_campaign:edit",
  "dial_campaign:view",
  "dnc:create",
  "dnc:edit",
  "dnc:view",
  // No "dnc:delete" - a list is disabled through `dnc:edit`, never removed.
  // The org chart's restricted half (0178). No `delete`: §6.5's timeline and
  // any dispute about what was signed both need the row to survive, so a
  // contract is `ended`, which is an `edit`. No `export` either - nothing
  // emits contracts in bulk, and the directory export (§6.6) is names and
  // titles built in the browser from rows already on screen.
  "employment_contract:create",
  "employment_contract:edit",
  "employment_contract:view",
  // The finance module. No `finance:delete` and there never will be: §6.3 is a
  // MUST - "never edit or delete a posted payment or ledger row" - so a delete
  // cell would be a checkbox with no route behind it, and worse, one somebody
  // might believe. A correction is a reversal, which is a `finance:create`.
  //
  // `finance:export` is live because the reports and the ledger CSV are the
  // one place a client's whole money history leaves the system.
  "finance:create",
  "finance:edit",
  "finance:export",
  "finance:view",
  // `incentive:edit` is the approval and the payout marking - §10's
  // `calculated -> approved -> paid`. No `create`: a payout row is produced by
  // the calculation run, never typed, and no `delete` for the same reason a
  // ledger row has none.
  "incentive:edit",
  "incentive:view",
  "invoice:create",
  "invoice:edit",
  "invoice:view",
  "lead:create",
  "lead:edit",
  "lead:view",
  "lead_board:create",
  "lead_board:delete",
  "lead_board:edit",
  // Doc 39 P4. No `partner:delete` - a partner is suspended or terminated,
  // and deleting one would orphan every lead they ever submitted.
  "partner:create",
  "partner:edit",
  "partner:view",
  // The org chart (0177). `delete` IS live here, unusually for this list, and
  // §4.3 is why: a seat that was created by mistake has to be removable, and
  // the route refuses one that still has reports until they are reassigned (or
  // the owner chooses "promote reports to parent"). It is not a soft-delete
  // shaped like a status, because an abolished seat that mattered gets
  // `effective_to` instead - two different things, both needed.
  "position:create",
  "position:delete",
  "position:edit",
  "position:view",
  "product:create",
  "product:edit",
  "product:view",
  "quotation:create",
  "quotation:edit",
  "quotation:view",
  // Doc 39 P6. No `resource:delete` - a unit is retired, never removed, or
  // every appointment that ever used it loses what it was for.
  "resource:create",
  "resource:edit",
  "resource:view",
  "task:create",
  "task:edit",
  "task:view",
  // Doc 39 P3. Sorts last. No `web_form:delete` - a form is closed, because
  // deleting it would orphan the lead_sources row every lead it produced is
  // attributed to AND 404 a link already in somebody's email signature.
  "web_form:create",
  "web_form:edit",
  "web_form:view",
  // Enforced INSIDE create/update/reassign in tasks.controller.ts, via an
  // inline `hasCrmGrant()` check rather than `@RequireCrmPermission` - it only
  // applies when the chosen assignee is an owner or manager, which a
  // route-level guard cannot express without wrongly blocking every other
  // target too. permissions-inventory.spec.ts carries the matching exception.
  "task:assign_up",
];

/** Does any route actually check this cell? See ENFORCED_PERMISSIONS. */
export function isPermissionEnforced(
  objectType: PermissionObjectType | string,
  action: PermissionAction | string,
): boolean {
  return (ENFORCED_PERMISSIONS as readonly string[]).includes(`${objectType}:${action}`);
}
