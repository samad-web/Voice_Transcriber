import { getAdminPool, withOrgContext } from "@aura/db";

/**
 * A6, Milestone 3: does the dual-write still agree with itself?
 *
 * `projectLeadToCrm` (crm-objects.ts) has written a `contacts`/`deals` row
 * alongside every qualifying lead since M3 of CRM Phase 1 - but nothing has
 * ever checked that the two sides stay in agreement once a human starts
 * editing either one. This sweep is that check, run continuously through the
 * A6 burn-in period so the eventual read/write cutover is backed by evidence,
 * not hope. Findings land in `crm_reconciliation_log` (0054) rather than a
 * log line, because "what's still outstanding" needs to be reviewable in
 * bulk, not scrolled past.
 *
 * ── OFF BY DEFAULT ──────────────────────────────────────────────────────────
 *
 * Same asymmetry as every other opt-in sweep here: a burn-in nobody is
 * running yet costs nothing, and a sweep quietly writing rows to a table
 * nobody asked for is a different kind of surprise. CRM_RECONCILE_ENABLED
 * gates the whole thing.
 *
 * ── STAGE/STATUS ARE GATED SEPARATELY ───────────────────────────────────────
 *
 * A6's Milestone 2 taught a lead's `PATCH` to push its stage/status onto the
 * linked deal - but before that landed, every touched lead's stage diverged
 * from its deal by construction (projectLeadToCrm only sets a deal's stage
 * ONCE, on creation). Comparing stage/status is only informative once
 * Milestone 2 is verified live in a given environment, so it's a second flag
 * (CRM_RECONCILE_INCLUDE_STAGE) rather than bundled into the main one -
 * flipping it on prematurely would flood the log with a divergence everyone
 * already knows about.
 *
 * ── WHAT IT DOES NOT FLAG ────────────────────────────────────────────────────
 *
 * `deals.owner_user_id`/telecaller assignment: there is no mapping from a
 * lead's `telecaller_device_id` (a device) to a deal's owner (a user) -
 * CRM_STATUS.md already states why - so this was never something the two
 * sides could agree on, and comparing it would just be permanent noise.
 */

const BATCH = positiveInt(process.env.CRM_RECONCILE_BATCH, 500);
/** Only leads touched recently - a lead that has matched for months needs no more sweeps. */
const WINDOW_DAYS = positiveInt(process.env.CRM_RECONCILE_WINDOW_DAYS, 3);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function reconcileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CRM_RECONCILE_ENABLED === "true";
}

export function includeStageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CRM_RECONCILE_INCLUDE_STAGE === "true";
}

interface JoinedRow {
  lead_id: string;
  lead_title: string;
  lead_value_num: string | null;
  lead_facts: Record<string, unknown> | null;
  lead_call_count: number;
  lead_last_activity_at: Date;
  lead_stage: string;
  lead_status: string;
  deal_id: string | null;
  deal_name: string | null;
  deal_amount: string | null;
  deal_facts: Record<string, unknown> | null;
  deal_call_count: number | null;
  deal_last_activity_at: Date | null;
  deal_stage: string | null;
  deal_status: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_facts: Record<string, unknown> | null;
  contact_call_count: number | null;
  contact_last_activity_at: Date | null;
}

interface Finding {
  dealId: string | null;
  contactId: string | null;
  field: string;
  leadValue: string | null;
  crmValue: string | null;
}

/** Every key `leadFacts` fills must be present, with the same value, on the CRM side. */
function factsMatch(leadFacts: Record<string, unknown> | null, crmFacts: Record<string, unknown> | null): boolean {
  for (const [key, value] of Object.entries(leadFacts ?? {})) {
    if (JSON.stringify((crmFacts ?? {})[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  return String(a ?? "") === String(b ?? "");
}

function findMismatches(row: JoinedRow, includeStage: boolean): Finding[] {
  const findings: Finding[] = [];

  if (!row.deal_id) {
    findings.push({ dealId: null, contactId: null, field: "deal_missing", leadValue: row.lead_id, crmValue: null });
    return findings; // nothing else on the deal side to compare without one
  }
  if (!row.contact_id) {
    findings.push({ dealId: row.deal_id, contactId: null, field: "contact_missing", leadValue: row.lead_id, crmValue: null });
  }

  if (!sameValue(row.lead_title, row.deal_name)) {
    findings.push({ dealId: row.deal_id, contactId: row.contact_id, field: "deal.name", leadValue: row.lead_title, crmValue: row.deal_name });
  }
  if (!sameValue(row.lead_value_num, row.deal_amount)) {
    findings.push({
      dealId: row.deal_id,
      contactId: row.contact_id,
      field: "deal.amount",
      leadValue: row.lead_value_num,
      crmValue: row.deal_amount,
    });
  }
  if (!factsMatch(row.lead_facts, row.deal_facts)) {
    findings.push({
      dealId: row.deal_id,
      contactId: row.contact_id,
      field: "deal.facts",
      leadValue: JSON.stringify(row.lead_facts ?? {}),
      crmValue: JSON.stringify(row.deal_facts ?? {}),
    });
  }
  if (!sameValue(row.lead_call_count, row.deal_call_count)) {
    findings.push({
      dealId: row.deal_id,
      contactId: row.contact_id,
      field: "deal.call_count",
      leadValue: String(row.lead_call_count),
      crmValue: String(row.deal_call_count),
    });
  }
  if (!sameValue(row.lead_last_activity_at?.toISOString(), row.deal_last_activity_at?.toISOString())) {
    findings.push({
      dealId: row.deal_id,
      contactId: row.contact_id,
      field: "deal.last_activity_at",
      leadValue: row.lead_last_activity_at?.toISOString() ?? null,
      crmValue: row.deal_last_activity_at?.toISOString() ?? null,
    });
  }
  if (includeStage) {
    if (!sameValue(row.lead_stage, row.deal_stage)) {
      findings.push({ dealId: row.deal_id, contactId: row.contact_id, field: "deal.stage", leadValue: row.lead_stage, crmValue: row.deal_stage });
    }
    if (!sameValue(row.lead_status, row.deal_status)) {
      findings.push({
        dealId: row.deal_id,
        contactId: row.contact_id,
        field: "deal.status",
        leadValue: row.lead_status,
        crmValue: row.deal_status,
      });
    }
  }

  if (row.contact_id) {
    if (!sameValue(row.lead_title, row.contact_name)) {
      findings.push({
        dealId: row.deal_id,
        contactId: row.contact_id,
        field: "contact.display_name",
        leadValue: row.lead_title,
        crmValue: row.contact_name,
      });
    }
    if (!factsMatch(row.lead_facts, row.contact_facts)) {
      findings.push({
        dealId: row.deal_id,
        contactId: row.contact_id,
        field: "contact.facts",
        leadValue: JSON.stringify(row.lead_facts ?? {}),
        crmValue: JSON.stringify(row.contact_facts ?? {}),
      });
    }
    if (!sameValue(row.lead_call_count, row.contact_call_count)) {
      findings.push({
        dealId: row.deal_id,
        contactId: row.contact_id,
        field: "contact.call_count",
        leadValue: String(row.lead_call_count),
        crmValue: String(row.contact_call_count),
      });
    }
    if (!sameValue(row.lead_last_activity_at?.toISOString(), row.contact_last_activity_at?.toISOString())) {
      findings.push({
        dealId: row.deal_id,
        contactId: row.contact_id,
        field: "contact.last_activity_at",
        leadValue: row.lead_last_activity_at?.toISOString() ?? null,
        crmValue: row.contact_last_activity_at?.toISOString() ?? null,
      });
    }
  }

  return findings;
}

type Queryable = { query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

/**
 * Insert one finding, but only if it's NEW - the most recently logged row
 * for this (lead, field) pair had a different lead/crm value, or there is no
 * prior row at all. A persistently-legitimate divergence (a deal a human
 * keeps editing on purpose) would otherwise re-log identically every sweep.
 */
async function logIfChanged(client: Queryable, orgId: string, leadId: string, f: Finding): Promise<boolean> {
  const { rows } = await client.query<{ inserted: boolean }>(
    `INSERT INTO crm_reconciliation_log (org_id, lead_id, deal_id, contact_id, field, lead_value, crm_value)
     SELECT $1, $2, $3, $4, $5, $6, $7
      WHERE NOT EXISTS (
        SELECT 1 FROM (
          SELECT lead_value, crm_value FROM crm_reconciliation_log
           WHERE lead_id = $2 AND field = $5
           ORDER BY detected_at DESC LIMIT 1
        ) last
        WHERE last.lead_value IS NOT DISTINCT FROM $6 AND last.crm_value IS NOT DISTINCT FROM $7
      )
     RETURNING true AS inserted`,
    [orgId, leadId, f.dealId, f.contactId, f.field, f.leadValue, f.crmValue],
  );
  return rows.length > 0;
}

/**
 * Compare one org's recently-active leads against their dual-written
 * deal/contact. Returns how many NEW findings were logged (not how many
 * leads were checked - most sweeps find nothing new to say).
 */
export async function reconcileOrg(client: Queryable, orgId: string): Promise<number> {
  const includeStage = includeStageEnabled();
  const { rows } = await client.query<JoinedRow>(
    `SELECT
        l.id AS lead_id, l.title AS lead_title, l.value_num AS lead_value_num,
        l.facts AS lead_facts, l.call_count AS lead_call_count,
        l.last_activity_at AS lead_last_activity_at, l.stage AS lead_stage, l.status AS lead_status,
        d.id AS deal_id, d.name AS deal_name, d.amount AS deal_amount, d.facts AS deal_facts,
        d.call_count AS deal_call_count, d.last_activity_at AS deal_last_activity_at,
        d.stage AS deal_stage, d.status AS deal_status,
        c.id AS contact_id, c.display_name AS contact_name, c.facts AS contact_facts,
        c.call_count AS contact_call_count, c.last_activity_at AS contact_last_activity_at
      FROM leads l
      LEFT JOIN deals d ON d.source_lead_id = l.id
      LEFT JOIN contacts c ON c.id = d.contact_id
     WHERE l.last_activity_at > now() - make_interval(days => $1)
     ORDER BY l.last_activity_at DESC
     LIMIT $2`,
    [WINDOW_DAYS, BATCH],
  );

  let logged = 0;
  for (const row of rows) {
    for (const finding of findMismatches(row, includeStage)) {
      if (await logIfChanged(client, orgId, row.lead_id, finding)) logged++;
    }
  }
  return logged;
}

/** Runs across every active org, each under its own RLS context - same shape as reaper.ts. */
export async function sweepCrmReconciliation(): Promise<number> {
  if (!reconcileEnabled()) return 0;

  const { rows: orgs } = await getAdminPool().query<{ id: string }>(
    "SELECT id FROM organizations WHERE status = 'active'",
  );

  let total = 0;
  for (const org of orgs) {
    total += await withOrgContext(org.id, (client) => reconcileOrg(client, org.id));
  }
  if (total > 0) console.log(`crm reconcile: logged ${total} new finding(s)`);
  return total;
}

/** Every 30 minutes - frequent enough to catch drift during a burn-in without hammering every org's tables. */
export function startCrmReconcileSweep(): NodeJS.Timeout | null {
  if (!reconcileEnabled()) {
    console.log("crm reconcile: OFF (set CRM_RECONCILE_ENABLED=true to run the A6 shadow-read burn-in check)");
    return null;
  }

  console.log(
    `crm reconcile: ON - comparing leads touched in the last ${WINDOW_DAYS}d against their dual-written deal/contact` +
      (includeStageEnabled() ? " (including stage/status)" : " (stage/status excluded until Milestone 2 is verified live)"),
  );

  const interval = positiveInt(process.env.CRM_RECONCILE_INTERVAL_MS, 30 * 60 * 1000);
  setTimeout(() => {
    void sweepCrmReconciliation().catch((err) => console.error("crm reconcile:", err));
  }, 60_000).unref?.();

  return setInterval(
    () => void sweepCrmReconciliation().catch((err) => console.error("crm reconcile:", err)),
    interval,
  );
}
