import { getAdminPool, withOrgContext } from "@aura/db";
import { OWNER_ROLE_ADMINS } from "@aura/shared";

/**
 * The response SLA sweep (CRM dashboard Phase 7, migration 0109).
 *
 * `organizations.response_sla_minutes` says how long a new lead may wait for a
 * first response (`leads.first_responded_at`, 0093). The response-time report
 * shows AFTERWARDS how often that was missed; this tells somebody WHILE it is
 * still being missed, when answering the lead can still help.
 *
 * ── WHO IS TOLD ──────────────────────────────────────────────────────────
 *
 * The assigned telecaller, if they have a console login, and every owner and
 * manager. The telecaller because it is theirs to answer; the managers because
 * an unassigned lead has nobody else, and a lead that is assigned to somebody
 * off sick is exactly the case the SLA exists to catch.
 *
 * ── ONCE PER LEAD, PER PERSON ────────────────────────────────────────────
 *
 * `dedupe_key = sla_breach:<leadId>` - a lead that is still waiting on the next
 * pass is the same fact, not a new one. Reassigning it does not re-raise for
 * the managers either; it does reach the NEW telecaller, whose key is unused.
 *
 * ── THE SEVEN-DAY WINDOW ─────────────────────────────────────────────────
 *
 * Only leads created in the last week. Without it, the first pass after this
 * ships would tell every manager about every lead nobody logged a response to
 * since the product began - hundreds of notifications about history, which is
 * how a bell gets muted on day one.
 *
 * NOTHING HERE SENDS. It writes in-app notifications and nothing else.
 */

const WINDOW_DAYS = 7;

/** "30 minutes", "1 hour", "1 h 30 min", "24 hours" - for the notification title. */
export function formatSla(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} h ${rest} min`;
}

/** Returns how many notifications were written across every org. */
export async function runSlaBreachSweep(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<{ id: string; response_sla_minutes: number }>(
    `SELECT id, response_sla_minutes FROM organizations WHERE status = 'active'`,
  );

  let total = 0;
  for (const org of orgs) {
    try {
      total += await raiseForOrg(org.id, org.response_sla_minutes);
    } catch (err) {
      // One tenant's failure must not end the pass for the others.
      console.error(`sla breach: org ${org.id} failed:`, err);
    }
  }
  if (total > 0) console.log(`sla breach: ${total} notification(s) raised`);
  return total;
}

async function raiseForOrg(orgId: string, slaMinutes: number): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
       SELECT $1, r.user_id, 'sla_breach',
              left(COALESCE(NULLIF(btrim(l.contact_name), ''), l.title)
                   || ' has waited over ' || $2 || ' for a first response', 200),
              CASE WHEN tc.id IS NULL THEN 'Nobody is assigned to this lead yet.'
                   ELSE 'Assigned to ' || tc.display_name || '.' END,
              '/owner/leads?focus=' || l.id,
              'sla_breach:' || l.id
         FROM leads l
         LEFT JOIN telecallers tc ON tc.id = l.assigned_telecaller_id
         CROSS JOIN LATERAL (
           SELECT tc.user_id WHERE tc.user_id IS NOT NULL AND tc.status = 'active'
           UNION
           SELECT m.user_id FROM memberships m
            WHERE m.org_id = l.org_id AND m.owner_role = ANY($3::text[])
         ) r(user_id)
        WHERE l.org_id = $1
          AND l.status = 'open'
          AND l.first_responded_at IS NULL
          AND l.created_at > now() - make_interval(days => $4)
          AND l.created_at <= now() - make_interval(mins => $5)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [orgId, formatSla(slaMinutes), OWNER_ROLE_ADMINS, WINDOW_DAYS, slaMinutes],
    );
    return rowCount ?? 0;
  });
}

export function startSlaBreachSweep(): NodeJS.Timeout {
  // Five minutes: the shortest SLA the column allows is five, and a sweep
  // slower than that would turn "within 5 minutes" into "within 15".
  const interval = Number(process.env.SLA_BREACH_INTERVAL_MS ?? 5 * 60 * 1000);
  return setInterval(() => {
    void runSlaBreachSweep().catch((err) => console.error("sla breach sweep:", err));
  }, interval);
}
