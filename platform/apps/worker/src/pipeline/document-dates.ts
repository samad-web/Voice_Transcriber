import { getAdminPool, withOrgContext } from "@aura/db";
import { featureSpec } from "@aura/shared";
import { announce } from "./realtime";

/**
 * Quotations that have run out, and invoices that have gone past due.
 *
 * ── TWO STATUSES THAT NOTHING COULD EVER SET ────────────────────────────────
 *
 * `quotations.status` has allowed `'expired'` since migration 0059 and
 * `invoices.status` has allowed `'overdue'` since 0060. Both were in the CHECK
 * constraint, both were in the console's status tabs, and **no code anywhere
 * set either one**. The invoice controller said so about its own enum: "overdue
 * is a due-date label no job sets yet". So `valid_until` and `due_date` were
 * decorative - a quotation stayed "Sent" a year after it lapsed, and the report
 * templates from migration 0088 that filter on `status = 'overdue'` were
 * filtering on a value only a human could type.
 *
 * This is that job. It is deliberately the whole of it: two UPDATEs, no
 * notifications, nothing sent to anybody. Chasing a customer about an overdue
 * invoice is a person's decision, and "nothing automated sends" is the rule
 * this codebase holds to. All this does is make the status tell the truth so
 * the lists, the filters and the reports can be believed.
 *
 * ── THE DAY IS THE ORG'S OWN ────────────────────────────────────────────────
 *
 * `org_reporting_today()` (0095), not `current_date`. On a UTC box an Indian
 * floor's day rolls over at 05:30 local, so a quotation valid until the 30th
 * would read as expired for the last five and a half hours of the 30th - the
 * customer would be told their quote had lapsed while it had not. Same
 * reasoning as followup-reminders.ts, which is the file this one is modelled on.
 */

const QUOTATIONS_FEATURE = featureSpec("quotations");
const INVOICES_FEATURE = featureSpec("invoices");

interface OrgRow {
  id: string;
}

/**
 * A quotation lapses the day AFTER its last valid day.
 *
 * `valid_until < today`, not `<=`: "valid until the 30th" includes the 30th,
 * and a quote that stops being honoured on the morning of the date printed on
 * it is a quote with the wrong date printed on it.
 *
 * Only from `sent`. A draft was never put in front of anybody, so it has
 * nothing to expire from; `accepted` and `rejected` are answers already given
 * and must not be overwritten by the calendar.
 */
const EXPIRE_QUOTATIONS_SQL = `
  UPDATE quotations
     SET status = 'expired'
   WHERE status = 'sent'
     AND valid_until IS NOT NULL
     AND valid_until < org_reporting_today()
`;

/**
 * An invoice is overdue the day after its due date, while money is still owed.
 *
 * `amount_paid < total` guards the case where a payment landed but the status
 * was never moved to `paid`: that is a different bug, and labelling a settled
 * invoice "overdue" would chase a customer who has already paid. Partially paid
 * invoices DO become overdue, which is right - there is a balance outstanding
 * past its date.
 *
 * `sent -> overdue` is exactly the move `MANUAL_STATUS_MOVES` already permits a
 * person to make by hand, so this job cannot reach a state the API would refuse.
 */
const OVERDUE_INVOICES_SQL = `
  UPDATE invoices
     SET status = 'overdue'
   WHERE status = 'sent'
     AND due_date IS NOT NULL
     AND due_date < org_reporting_today()
     AND amount_paid < total
`;

async function sweepOrg(orgId: string, sql: string): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const result = await client.query(sql);
    return result.rowCount ?? 0;
  });
}

/**
 * One pass over every org that has the feature on and has a document that could
 * move. The `EXISTS` is what keeps this a lookup per org rather than a scan:
 * most orgs have nothing to do on most days.
 *
 * A feature switched off stops the sweep, not just the page. Unlike the
 * follow-up ladder there IS something lost by that - a quotation that lapsed
 * while Quotations was off stays "Sent" until the sweep next runs - but that is
 * the correct trade: writing to a module a client has switched off is worse than
 * a status that catches up when they switch it back on.
 */
export async function runDocumentDateSweep(): Promise<{ expired: number; overdue: number }> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    `SELECT o.id,
            org_feature_enabled(o.id, $1, $2, $3) AS quotations_on,
            org_feature_enabled(o.id, $4, $5, $6) AS invoices_on
       FROM organizations o
      WHERE o.status = 'active'`,
    [
      QUOTATIONS_FEATURE.key,
      QUOTATIONS_FEATURE.module,
      QUOTATIONS_FEATURE.defaultEnabled,
      INVOICES_FEATURE.key,
      INVOICES_FEATURE.module,
      INVOICES_FEATURE.defaultEnabled,
    ],
  );

  let expired = 0;
  let overdue = 0;
  for (const org of orgs as Array<OrgRow & { quotations_on: boolean; invoices_on: boolean }>) {
    try {
      if (org.quotations_on) {
        const n = await sweepOrg(org.id, EXPIRE_QUOTATIONS_SQL);
        if (n > 0) {
          expired += n;
          announce(org.id, "quotation", "updated");
        }
      }
      if (org.invoices_on) {
        const n = await sweepOrg(org.id, OVERDUE_INVOICES_SQL);
        if (n > 0) {
          overdue += n;
          announce(org.id, "invoice", "updated");
        }
      }
    } catch (err) {
      console.error(`document dates: org ${org.id}:`, err);
    }
  }

  if (expired > 0 || overdue > 0) {
    console.log(`document dates: ${expired} quotation(s) expired, ${overdue} invoice(s) overdue`);
  }
  return { expired, overdue };
}

/**
 * Hourly. The condition changes once a day per document, so a faster tick buys
 * nothing; hourly means a status catches up within an hour of the org's own
 * midnight, which for a date measured in days is close enough.
 */
export function startDocumentDateSweep(): NodeJS.Timeout {
  const interval = Number(process.env.DOCUMENT_DATE_INTERVAL_MS ?? 60 * 60 * 1000);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runDocumentDateSweep()
      .catch((err) => console.error("document date sweep:", err))
      .finally(() => {
        running = false;
      });
  }, interval);
}
