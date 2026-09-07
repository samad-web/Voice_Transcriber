import {
  type FeatureKey,
  type FeatureOverrides,
  type ResolvedFeature,
  resolveFeatures,
} from "@aura/shared";

interface QueryClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Resolve the whole feature catalogue for the tenant on this connection
 * (migration 0101).
 *
 * ── ONE ROUND TRIP, NOT TWO ─────────────────────────────────────────────────
 *
 * The entitlement lives on `organizations` and the client's overrides live in
 * `org_feature_settings`, and this deployment pays ~125ms per exchange (Mumbai
 * API, Seoul database). Two obvious queries would be a quarter-second on every
 * gated request, so the overrides ride along as an aggregated column on the
 * organizations read - the same trick `contextFor` uses for memberships.
 *
 * ── WHY THE ORG ID IS NOT A PARAMETER ───────────────────────────────────────
 *
 * Same reasoning as `orgHasModule`, which this sits beside: RLS has already
 * narrowed both tables to the one org this request may see, so there is no org
 * predicate here to get wrong and no way to ask about a tenant other than the
 * one the caller is scoped to. Passing an id would create exactly that
 * possibility for no benefit.
 *
 * ── FAIL-CLOSED ─────────────────────────────────────────────────────────────
 *
 * An org row that does not come back (impossible under a correct RLS context,
 * reachable if this is ever called outside one) resolves with NO modules, which
 * puts every feature in `unavailable`. A missing answer must not be read as
 * permission.
 */
export async function loadOrgFeatures(
  client: QueryClient,
): Promise<Map<FeatureKey, ResolvedFeature>> {
  const { rows } = await client.query(
    `SELECT o.enabled_modules AS modules,
            COALESCE(
              (SELECT jsonb_object_agg(f.feature_key, f.enabled)
                 FROM org_feature_settings f
                WHERE f.org_id = o.id),
              '{}'::jsonb) AS overrides
       FROM organizations o
      LIMIT 1`,
  );

  const row = rows[0];
  const modules = Array.isArray(row?.modules) ? (row.modules as string[]) : [];
  const overrides = (row?.overrides ?? {}) as FeatureOverrides;
  return resolveFeatures(modules, overrides);
}

/**
 * Is one feature on for the tenant on this connection?
 *
 * Resolves the whole catalogue rather than reading one row, because a feature's
 * state is not a property of its own row: `invoices` is off when `products` is,
 * and a single-row read would answer "on" for a feature the console correctly
 * refuses to show. The cost is the same query either way.
 */
export async function orgHasFeature(client: QueryClient, feature: FeatureKey): Promise<boolean> {
  const resolved = await loadOrgFeatures(client);
  return resolved.get(feature)?.state === "on";
}
