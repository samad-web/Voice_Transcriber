import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { FEATURES, FeatureKey, featureSpec } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { loadOrgFeatures } from "../../common/org-features";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const UpdateFeaturesBody = z.object({
  /**
   * A partial map. Only the keys present are considered, so the page can send
   * one switch rather than the whole board - which matters because two people
   * on the settings page at once would otherwise have the second save silently
   * revert the first's change to an unrelated feature.
   */
  features: z.record(z.string(), z.boolean()),
});

/**
 * The client's own feature switchboard (migration 0101).
 *
 * ── WHY THIS IS NOT AN EXTENSION OF THE OPERATOR'S MODULE TOGGLE ────────────
 *
 * `PATCH /v1/admin/tenants/:id/modules` already exists and turns CRM on and
 * off for a tenant. It is the wrong endpoint to hand a customer, twice over:
 * it is mounted cross-tenant behind the platform admin key, and what it writes
 * is the ENTITLEMENT - what the tenant has bought. A client who could write it
 * could grant themselves `call_intel`, which is the right to read verbatim
 * transcripts of their customers' phone calls, and 0072's header is explicit
 * that this is a decision per client contract.
 *
 * So the client gets a second, strictly narrower control, and the composition
 * is enforced in `resolveFeatures` rather than trusted here: whatever this
 * endpoint stores, a feature whose module is absent resolves `unavailable`.
 *
 * ── THE READ IS OWNER + MANAGER, THE WRITE IS OWNER ONLY ────────────────────
 *
 * Same split as the Team page, for the same reason. A manager needs to know
 * why Invoices is missing before they raise it as a bug; only an owner decides
 * which parts of the product the business uses. `@RequireOwnerRole` is real
 * enforcement here (OwnerRoleGuard resolves the persona from `memberships`,
 * not from a header), unlike `/v1/org/policy` where only the server action
 * gates it.
 */
@Controller("owner/features")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class OrgFeaturesController {
  constructor(private readonly db: DbService) {}

  /**
   * The catalogue and this workspace's resolved state, together.
   *
   * The catalogue rides along rather than being a second endpoint or a copy in
   * the web bundle: the page has to render a label, a description and a reason
   * for every switch, and a client tier holding its own copy of the catalogue
   * is how a feature ends up with a switch that writes a key the API does not
   * recognise.
   */
  @Get()
  @RequireOwnerRole("owner", "manager")
  async list(@OrgId() orgId: string) {
    const resolved = await this.db.withOrg(orgId, (client) => loadOrgFeatures(client));
    return {
      features: FEATURES.map((spec) => {
        const state = resolved.get(spec.key);
        return {
          key: spec.key,
          label: spec.label,
          blurb: spec.blurb,
          group: spec.group,
          module: spec.module,
          locked: spec.locked === true,
          requires: spec.requires ?? [],
          state: state?.state ?? "unavailable",
          blockedBy: state?.blockedBy ?? null,
        };
      }),
    };
  }

  /**
   * Flip one or more switches.
   *
   * ── WHAT IS REFUSED, AND WHAT IS SIMPLY IGNORED ─────────────────────────
   *
   * A key outside the catalogue is REFUSED, loudly. It is a bug in the caller
   * - nothing in the console can produce one - and storing it would leave a row
   * that never affects anything and that the next person to read the table has
   * to work out.
   *
   * A LOCKED feature is refused for the same reason it is locked: the request
   * is asking for a workspace that cannot administer itself.
   *
   * A feature whose module the tenant does not hold is neither refused nor
   * stored. The client is expressing a preference for a product they may buy
   * later, and there is no harm in it - `resolveFeatures` keeps it
   * `unavailable` until the entitlement arrives, at which point their stored
   * choice is already there. Refusing would be pedantic; storing it silently is
   * the honest reading of what they asked for.
   *
   * ── STORED SPARSELY ──────────────────────────────────────────────────────
   *
   * A value equal to the catalogue default DELETES the row rather than writing
   * it. "Reset to default" and "set it to the value that happens to be the
   * default today" are then the same operation, which is what lets the product
   * change a default later and have it reach every tenant who never expressed a
   * preference.
   *
   * ── AND ONLY THE KEYS THAT WERE SENT ARE TOUCHED ─────────────────────────
   *
   * The PUT is partial by contract, not by convenience - see the loop below for
   * the concurrent save it protects.
   */
  @Put()
  @RequireOwnerRole("owner")
  async update(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = UpdateFeaturesBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const requested = parsed.data.features;
    for (const key of Object.keys(requested)) {
      const known = FeatureKey.safeParse(key);
      if (!known.success) throw new BadRequestException(`unknown feature: ${key}`);
      if (featureSpec(known.data).locked && requested[key] === false) {
        throw new BadRequestException(
          `${featureSpec(known.data).label} cannot be switched off - it is how this ` +
            `workspace is administered.`,
        );
      }
    }

    const actorId = req.principal?.userId ?? null;

    return this.db.withOrg(orgId, async (client) => {
      // What is stored now, read inside the transaction that is about to write.
      // Only used for the audit diff - the writes below touch nothing it does
      // not name, so a stale read here cannot cost anybody a setting.
      const { rows: existing } = await client.query<{ feature_key: string; enabled: boolean }>(
        `SELECT feature_key, enabled FROM org_feature_settings WHERE org_id = $1`,
        [orgId],
      );
      const before: Record<string, boolean> = {};
      for (const row of existing) before[row.feature_key] = row.enabled;

      // ── ONLY THE KEYS THAT WERE SENT ARE TOUCHED ─────────────────────
      //
      // The obvious implementation - merge the request over what is stored,
      // delete every row not in the merged set, re-insert the rest - loses a
      // concurrent save, and does it silently.
      //
      // Two owners on the Features page at the same time: A switches off
      // Duplicates, B switches off Import. Both read `{}`. A writes its row.
      // B's "delete everything not in my set" then removes A's row and B's
      // save reports success. `FOR UPDATE` does not help, because there is no
      // row to lock - PostgreSQL takes no gap locks at READ COMMITTED.
      //
      // Per-key writes have no such interleaving: a request that never
      // mentions Duplicates cannot delete Duplicates. It also makes the API's
      // partial-PUT contract real rather than nominal.
      for (const [key, value] of Object.entries(requested)) {
        const spec = featureSpec(FeatureKey.parse(key));
        if (value === spec.defaultEnabled) {
          // Back to the default: DELETE, never store the default's current
          // value. That is what lets the product change a default later and
          // have it reach every tenant who never expressed a preference - see
          // `sparseOverrides` and 0101's header.
          await client.query(
            `DELETE FROM org_feature_settings WHERE org_id = $1 AND feature_key = $2`,
            [orgId, key],
          );
          continue;
        }
        await client.query(
          `INSERT INTO org_feature_settings (org_id, feature_key, enabled, updated_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, feature_key)
           DO UPDATE SET enabled = EXCLUDED.enabled,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = now()`,
          [orgId, key, value, actorId],
        );
      }

      // The diff, not the whole board. An audit entry saying "features were
      // saved" answers nothing; the question asked six weeks later is always
      // "when did Invoices disappear, and who did it".
      const changed = Object.fromEntries(
        Object.entries(requested).filter(([key, value]) => {
          const previous = before[key] ?? featureSpec(FeatureKey.parse(key)).defaultEnabled;
          return previous !== value;
        }),
      );

      if (Object.keys(changed).length > 0) {
        await client.query(
          // target_id is its OWN parameter ($4), not a second use of $1: org_id
          // is uuid and target_id is text, and one untyped placeholder feeding
          // both fails with 42P08 "inconsistent types deduced for parameter $1"
          // - which rolled back the whole save, so no change made on this page
          // ever stuck (doc 31 §2, found while fixing X9; reproduced against
          // Postgres with this exact statement).
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'user', $2, 'owner.features.update', 'organization', $4, $3::jsonb)`,
          [orgId, actorId ?? "unknown", JSON.stringify({ changed }), orgId],
        );
      }

      // Re-read rather than reconstruct. The resolved state has to reflect what
      // is actually stored after the writes - including anything a concurrent
      // save landed - and a merge computed in this process would report the
      // board this request thinks it produced rather than the one it did.
      const resolved = await loadOrgFeatures(client);

      return {
        features: FEATURES.map((spec) => ({
          key: spec.key,
          state: resolved.get(spec.key)?.state ?? "unavailable",
          blockedBy: resolved.get(spec.key)?.blockedBy ?? null,
        })),
      };
    });
  }
}
