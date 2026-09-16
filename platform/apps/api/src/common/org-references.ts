import { BadRequestException } from "@nestjs/common";

/**
 * Every id a request body uses to point at another row must name a row in the
 * CALLER'S org. This is the one place that is checked.
 *
 * ── WHY POSTGRES DOES NOT ALREADY DO THIS ──────────────────────────────────
 *
 * RLS hides another tenant's rows from SELECT, but a FOREIGN KEY check is not
 * a SELECT: Postgres runs referential-integrity checks as the table owner, and
 * they ignore row-level security. So `INSERT INTO contacts (account_id)` with
 * another tenant's account id SUCCEEDS under a perfectly scoped `withOrg`
 * transaction. Proven against the local database on 2026-09-15 (doc 23, A1/A2):
 * tenant A linked a contact to tenant B's account and user, then read that
 * user's name and email back through the owner join.
 *
 * `users` is worse than the rest - it has no RLS at all, because a person can
 * belong to several orgs - so for user ids the check is membership, not
 * visibility.
 *
 * ── HOW TO USE ──────────────────────────────────────────────────────────────
 *
 * Call inside the same `withOrg` transaction as the write, before it. `null`
 * and `undefined` are skipped: clearing a link, or not sending the field, is
 * always allowed. The org filter is explicit rather than left to RLS, so the
 * check means the same thing on a connection where RLS does not bind.
 */

/** Loose on purpose: controllers here type their client three different ways. */
type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/** Body field -> the table its id must exist in. */
const REFERENCE_TABLES = {
  contactId: "contacts",
  accountId: "accounts",
  dealId: "deals",
  workspaceId: "workspaces",
  quotationId: "quotations",
  productId: "products",
  telecallerId: "telecallers",
  pipelineId: "deal_pipelines",
  projectId: "crm_projects",
  marketingSourceId: "marketing_sources",
  deviceId: "devices",
} as const;

export type OrgReferenceField = keyof typeof REFERENCE_TABLES;
type MaybeId = string | null | undefined;
/** A single id, or a list of them (line items naming several products). */
export type OrgReferences = Partial<Record<OrgReferenceField, MaybeId | readonly MaybeId[]>>;

/** Human noun for the error message, so a 400 says what was wrong. */
const NOUN: Record<OrgReferenceField, string> = {
  contactId: "contact",
  accountId: "account",
  dealId: "deal",
  workspaceId: "workspace",
  quotationId: "quotation",
  productId: "product",
  telecallerId: "telecaller",
  pipelineId: "pipeline",
  projectId: "project",
  marketingSourceId: "marketing source",
  deviceId: "handset",
};

/**
 * 400 unless every present id names a row of the right type in `orgId`.
 *
 * One query per table actually present, not per field - a body naming a deal
 * and a contact costs two indexed lookups, a body naming neither costs nothing.
 */
export async function assertInOrg(client: Queryable, orgId: string, refs: OrgReferences): Promise<void> {
  const byTable = new Map<string, { field: OrgReferenceField; id: string }[]>();
  for (const [field, value] of Object.entries(refs) as [OrgReferenceField, MaybeId | readonly MaybeId[]][]) {
    const values: readonly MaybeId[] = Array.isArray(value) ? value : [value as MaybeId];
    for (const id of values) {
      if (id === null || id === undefined) continue;
      const table = REFERENCE_TABLES[field];
      const list = byTable.get(table) ?? [];
      list.push({ field, id });
      byTable.set(table, list);
    }
  }

  for (const [table, wanted] of byTable) {
    const ids = [...new Set(wanted.map((w) => w.id))];
    const { rows } = await client.query(
      `SELECT id FROM ${table} WHERE org_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, ids],
    );
    const found = new Set((rows as { id: string }[]).map((r) => r.id));
    const missing = wanted.find((w) => !found.has(w.id));
    // 400, not 404 or 403: the request is malformed from this org's point of
    // view, and the same answer for "exists elsewhere" and "exists nowhere" is
    // what stops this being a probe for other tenants' ids.
    if (missing) {
      throw new BadRequestException(`${missing.field}: no such ${NOUN[missing.field]} in this organization`);
    }
  }
}

/**
 * 400 unless every present user id is a member of `orgId`.
 *
 * Membership rather than existence, because `users` spans tenants: the id of
 * a real user who belongs only to another org must fail exactly like an id
 * that belongs to nobody.
 */
export async function assertMembers(
  client: Queryable,
  orgId: string,
  users: Record<string, string | null | undefined>,
): Promise<void> {
  const present = Object.entries(users).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (present.length === 0) return;

  const ids = [...new Set(present.map(([, id]) => id))];
  const { rows } = await client.query(
    `SELECT DISTINCT user_id FROM memberships WHERE org_id = $1 AND user_id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  const found = new Set((rows as { user_id: string }[]).map((r) => r.user_id));
  const missing = present.find(([, id]) => !found.has(id));
  if (missing) {
    throw new BadRequestException(`${missing[0]}: that user is not a member of this organization`);
  }
}
