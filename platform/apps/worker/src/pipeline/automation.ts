import {
  AutomationAction,
  AutomationConditions,
  dueDate,
  matchesConditions,
  parseCustomFieldValue,
  resolveTarget,
  valueColumnForType,
  type AutomationSubject,
  type CustomFieldSpec,
  type CustomFieldType,
} from "@aura/shared";
import { getAdminPool, withOrgContext } from "@aura/db";
import type { DbClient } from "./crm-dispatch";

/**
 * The automation engine (PRD Layer 2, migration 0049).
 *
 * The API enqueues one row per thing-that-happened and returns; this drains
 * the queue. That split keeps a tenant's own configuration off the critical
 * path of every console action - a rule with four actions must not make
 * dragging a card slower, and a rule that throws must not turn a successful
 * stage change into a 500 the user has to interpret.
 *
 * ── LOOPS ARE STRUCTURALLY IMPOSSIBLE ─────────────────────────────────────
 *
 * Rules can move deals; a moved deal is a stage change; a stage change is a
 * trigger. That is a loop unless something stops it, and the something is not
 * a depth counter - it is that NOTHING IN THIS FILE ENQUEUES AN EVENT. Only
 * the API (a person did something) and the sweep below (a deadline passed)
 * ever insert into automation_events.
 *
 * The cost is real and worth naming: a rule cannot chain into another rule.
 * "When it goes idle, move it to Nurture" will not then fire "when it enters
 * Nurture, create a task". Somebody will eventually want that, and the answer
 * is an explicit, bounded chain depth - not the accidental recursion that
 * removing this constraint would give them.
 *
 * ── NO SEND ACTION ────────────────────────────────────────────────────────
 *
 * Deliberately. Everything this engine can do is reversible and stays inside
 * the console: tasks, notifications, notes, field values, stage moves. A rule
 * that misfires at 3am creates work somebody deletes. A rule that could send
 * mail would reach customers who never asked to be in this CRM, and could not
 * be recalled. Sending stays where B4 put it - one message, composed by a
 * person, who confirmed the recipient.
 */

/** Per drain tick. Small enough that one tenant's burst cannot starve another. */
const BATCH = 50;
/** After this many failed attempts an event is parked rather than retried forever. */
const MAX_ATTEMPTS = 3;

interface EventRow {
  id: string;
  org_id: string;
  trigger: string;
  subject_type: string;
  subject_id: string;
  payload: AutomationSubject;
  attempts: number;
}

interface RuleRow {
  id: string;
  name: string;
  conditions: unknown;
  actions: unknown;
}

export interface ActionOutcome {
  type: string;
  ok: boolean;
  detail?: string;
}

/**
 * Apply one rule's actions to one subject.
 *
 * Every action reports its own outcome rather than throwing, so one
 * impossible action (a notify with nobody to notify) does not abandon the
 * three after it. The outcomes are written to `automation_runs`, which is
 * what makes "my rule ran but nothing happened" a question with an answer.
 */
export async function applyActions(
  client: DbClient,
  orgId: string,
  actions: AutomationAction[],
  subject: AutomationSubject,
  now: Date = new Date(),
): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];

  for (const action of actions) {
    try {
      switch (action.type) {
        case "create_task": {
          const assignee = resolveTarget(action.assignTo, subject);
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO tasks
               (org_id, title, notes, contact_id, account_id, deal_id,
                assignee_user_id, due_on, priority)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
              orgId,
              action.title,
              action.notes ?? null,
              subject.contactId ?? null,
              subject.accountId ?? null,
              subject.dealId ?? null,
              assignee,
              dueDate(action.dueInDays, now),
              action.priority,
            ],
          );
          // Telling the assignee, on the same terms as a hand-created task -
          // an automation that silently fills somebody's queue is worse than
          // one that does nothing, because they find out by being behind.
          if (assignee && rows[0]) {
            await client.query(
              `INSERT INTO notifications
                 (org_id, user_id, kind, title, body, link_path, deal_id, contact_id, task_id)
               VALUES ($1, $2, 'automation', $3, 'Created by an automation rule', '/owner/tasks', $4, $5, $6)`,
              [orgId, assignee, action.title, subject.dealId ?? null, subject.contactId ?? null, rows[0].id],
            );
          }
          outcomes.push({
            type: action.type,
            ok: true,
            detail: assignee ? "assigned" : "unassigned - nobody to give it to",
          });
          break;
        }

        case "notify": {
          const target = resolveTarget(action.target, subject);
          if (!target) {
            // Reported, not thrown. A deal with no owner is a normal state,
            // not a broken rule, and the operator needs to see which it was.
            outcomes.push({ type: action.type, ok: false, detail: "no user to notify" });
            break;
          }
          await client.query(
            `INSERT INTO notifications
               (org_id, user_id, kind, title, body, link_path, deal_id, contact_id, dedupe_key)
             VALUES ($1, $2, 'automation', $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
            [
              orgId,
              target,
              action.title,
              action.body ?? null,
              subject.dealId ? `/owner/deals` : subject.contactId ? `/owner/contacts/${subject.contactId}` : null,
              subject.dealId ?? null,
              subject.contactId ?? null,
              // Keyed on the day, so a sweep that keeps matching does not
              // send the same person the same line every ten minutes.
              `automation:${action.title}:${subject.dealId ?? subject.contactId ?? "none"}:${now
                .toISOString()
                .slice(0, 10)}`,
            ],
          );
          outcomes.push({ type: action.type, ok: true });
          break;
        }

        case "add_note": {
          if (!subject.dealId && !subject.contactId) {
            outcomes.push({ type: action.type, ok: false, detail: "nothing to attach a note to" });
            break;
          }
          await client.query(
            `INSERT INTO interactions
               (org_id, type, contact_id, deal_id, body, occurred_at, actor_label)
             VALUES ($1, 'note', $2, $3, $4, now(), 'automation')`,
            [orgId, subject.contactId ?? null, subject.dealId ?? null, action.body],
          );
          outcomes.push({ type: action.type, ok: true });
          break;
        }

        case "set_custom_field": {
          const detail = await setCustomField(client, orgId, action.key, action.value, subject);
          outcomes.push({ type: action.type, ok: detail === null, detail: detail ?? undefined });
          break;
        }

        case "move_stage": {
          if (!subject.dealId) {
            outcomes.push({ type: action.type, ok: false, detail: "no deal to move" });
            break;
          }
          const moved = await moveStage(client, orgId, subject.dealId, action.stage);
          outcomes.push({ type: action.type, ok: moved === null, detail: moved ?? undefined });
          break;
        }
      }
    } catch (err) {
      outcomes.push({
        type: action.type,
        ok: false,
        detail: String(err instanceof Error ? err.message : err).slice(0, 200),
      });
    }
  }

  return outcomes;
}

/** Returns null on success, or the reason it could not be done. */
async function setCustomField(
  client: DbClient,
  orgId: string,
  key: string,
  raw: string,
  subject: AutomationSubject,
): Promise<string | null> {
  const objectType = subject.dealId ? "deal" : subject.contactId ? "contact" : null;
  const recordId = subject.dealId ?? subject.contactId ?? null;
  if (!objectType || !recordId) return "no record to set a field on";

  const { rows } = await client.query<{
    id: string;
    label: string;
    type: string;
    required: boolean;
    options: Array<{ value: string; label: string }> | null;
    validation: { min?: number; max?: number } | null;
  }>(
    `SELECT id, label, type, required, options, validation
       FROM custom_field_definitions
      WHERE org_id = $1 AND object_type = $2 AND key = $3 AND status = 'active'`,
    [orgId, objectType, key],
  );
  const definition = rows[0];
  if (!definition) return `no active ${objectType} field named "${key}"`;

  const spec: CustomFieldSpec = {
    key,
    label: definition.label,
    type: definition.type as CustomFieldType,
    required: definition.required,
    options: definition.options ?? [],
    validation: definition.validation,
  };
  // The same validator the console uses. A rule that writes "high" into a
  // picklist with no such option is a misconfiguration, and it should be
  // reported in the run log rather than stored as a value nothing can render.
  const parsed = parseCustomFieldValue(spec, raw);
  if (!parsed.ok) return parsed.message;

  const column = valueColumnForType(spec.type);
  const table = `${objectType}_custom_field_values`;
  const idColumn = `${objectType}_id`;

  // `source = 'automation'`, which the human-owns-it rule (migration 0045)
  // treats exactly like the extraction: a value a person typed by hand is not
  // overwritten by a rule either. Somebody who corrects a field and then
  // watches an automation revert it has been given a worse tool than a
  // spreadsheet.
  await client.query(
    `INSERT INTO ${table} (org_id, ${idColumn}, field_id, ${column}, source)
     VALUES ($1, $2, $3, $4, 'automation')
     ON CONFLICT (${idColumn}, field_id)
     DO UPDATE SET ${column} = EXCLUDED.${column}, source = 'automation', updated_at = now()
      WHERE ${table}.source <> 'human'`,
    [orgId, recordId, definition.id, parsed.value],
  );
  return null;
}

/** Returns null on success, or the reason it could not be done. */
async function moveStage(
  client: DbClient,
  orgId: string,
  dealId: string,
  stage: string,
): Promise<string | null> {
  const { rows } = await client.query<{
    stage: string;
    status: string;
    stages: Array<{ key: string; label: string; terminal?: string }>;
  }>(
    `SELECT d.stage, d.status, p.stages
       FROM deals d JOIN deal_pipelines p ON p.id = d.pipeline_id
      WHERE d.id = $1`,
    [dealId],
  );
  const deal = rows[0];
  if (!deal) return "deal not found";

  const stages = Array.isArray(deal.stages) ? deal.stages : [];
  const target = stages.find((s) => s.key === stage);
  if (!target) return `"${stage}" is not a stage on this deal's pipeline`;
  if (deal.stage === stage) return null;

  const status = target.terminal === "won" ? "won" : target.terminal === "lost" ? "lost" : "open";

  await client.query(
    `UPDATE deals SET stage = $2, status = $3, stage_changed_at = now(), last_activity_at = now()
      WHERE id = $1`,
    [dealId, stage, status],
  );
  // The ledger records WHO moved it, and for an automation that is not a
  // user - `actor_label` carries it, the same two-column shape interactions
  // uses for a device.
  await client.query(
    `INSERT INTO deal_stage_transitions
       (org_id, deal_id, from_stage, to_stage, from_status, to_status, source, actor_label)
     VALUES ($1, $2, $3, $4, $5, $6, 'automation', 'automation rule')`,
    [orgId, dealId, deal.stage, stage, deal.status, status],
  );
  return null;
}

/** Process one queued event against every active rule for its trigger. */
export async function processEvent(client: DbClient, event: EventRow): Promise<void> {
  const { rows: rules } = await client.query<RuleRow>(
    `SELECT id, name, conditions, actions FROM automation_rules
      WHERE trigger = $1 AND status = 'active'`,
    [event.trigger],
  );

  for (const rule of rules) {
    const conditions = AutomationConditions.safeParse(rule.conditions ?? {});
    const actions = AutomationAction.array().safeParse(rule.actions ?? []);
    if (!conditions.success || !actions.success) {
      // A rule stored before a schema change, or edited into an invalid shape
      // by something that bypassed the API. Logged against the rule rather
      // than swallowed, because it looks configured and is not.
      await recordRun(client, event, rule.id, false, [], "rule failed validation");
      continue;
    }

    const matched = matchesConditions(conditions.data, event.payload);
    if (!matched) {
      // Non-matches are recorded too. "Why didn't my rule fire?" is the most
      // common question about any automation system, and a log of successes
      // alone cannot answer it.
      await recordRun(client, event, rule.id, false, []);
      continue;
    }

    const outcomes = await applyActions(client, event.org_id, actions.data, event.payload);
    await recordRun(client, event, rule.id, true, outcomes);
    await client.query(
      `UPDATE automation_rules SET run_count = run_count + 1, last_run_at = now() WHERE id = $1`,
      [rule.id],
    );
  }
}

async function recordRun(
  client: DbClient,
  event: EventRow,
  ruleId: string,
  matched: boolean,
  outcome: ActionOutcome[],
  error?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO automation_runs
       (org_id, rule_id, event_id, subject_type, subject_id, matched, outcome, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      event.org_id,
      ruleId,
      event.id,
      event.subject_type,
      event.subject_id,
      matched,
      JSON.stringify(outcome),
      error ?? null,
    ],
  );
}

/** One drain pass over the queue. */
export async function drainAutomationEvents(): Promise<number> {
  const { rows: events } = await getAdminPool().query<EventRow>(
    `SELECT id, org_id, trigger, subject_type, subject_id, payload, attempts
       FROM automation_events
      WHERE processed_at IS NULL AND attempts < $1
      ORDER BY created_at
      LIMIT $2`,
    [MAX_ATTEMPTS, BATCH],
  );

  let processed = 0;
  for (const event of events) {
    try {
      await withOrgContext(event.org_id, (client) => processEvent(client as DbClient, event));
      await getAdminPool().query(
        `UPDATE automation_events SET processed_at = now(), error = NULL WHERE id = $1`,
        [event.id],
      );
      processed++;
    } catch (err) {
      // attempts is incremented WITHOUT setting processed_at, so it retries
      // until MAX_ATTEMPTS and then parks - visible in the table rather than
      // silently gone.
      await getAdminPool().query(
        `UPDATE automation_events SET attempts = attempts + 1, error = $2 WHERE id = $1`,
        [event.id, String(err instanceof Error ? err.message : err).slice(0, 500)],
      );
      console.error(`automation event ${event.id} (${event.trigger}):`, err);
    }
  }
  return processed;
}

/**
 * The triggers no person causes: a deadline passing.
 *
 * Enqueues rather than executing, so sweep-produced events go through exactly
 * the same path as everything else - one place where rules are matched and
 * one place where runs are recorded.
 *
 * Both queries are guarded by "does any rule actually want this?", so a
 * deployment where nobody has written an idle-deal rule pays one cheap
 * indexed lookup per tick rather than scanning every tenant's deals.
 */
export async function sweepAutomationTriggers(): Promise<number> {
  const pool = getAdminPool();
  let queued = 0;

  const { rows: idleRules } = await pool.query<{ org_id: string; conditions: AutomationConditions }>(
    `SELECT org_id, conditions FROM automation_rules
      WHERE trigger = 'deal.idle' AND status = 'active'`,
  );
  for (const rule of idleRules) {
    const days = rule.conditions?.idleDays ?? 14;
    const { rowCount } = await pool.query(
      `INSERT INTO automation_events (org_id, trigger, subject_type, subject_id, payload, dedupe_key)
       SELECT d.org_id, 'deal.idle', 'deal', d.id,
              jsonb_build_object(
                'dealId', d.id, 'contactId', d.contact_id, 'accountId', d.account_id,
                'stage', d.stage, 'status', d.status,
                'amount', d.amount, 'dealOwnerUserId', d.owner_user_id,
                'idleDays', floor(EXTRACT(EPOCH FROM (now() - d.last_activity_at)) / 86400)
              ),
              -- One event per deal per day. The condition stays true every
              -- tick, and without this the rule would fire every ten minutes
              -- until somebody touched the deal.
              'deal.idle:' || d.id || ':' || to_char(now(), 'YYYY-MM-DD')
         FROM deals d
        WHERE d.org_id = $1 AND d.status = 'open'
          AND d.last_activity_at < now() - ($2 || ' days')::interval
       ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [rule.org_id, days],
    );
    queued += rowCount ?? 0;
  }

  const { rows: overdueRules } = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM automation_rules
      WHERE trigger = 'task.overdue' AND status = 'active'`,
  );
  for (const rule of overdueRules) {
    const { rowCount } = await pool.query(
      `INSERT INTO automation_events (org_id, trigger, subject_type, subject_id, payload, dedupe_key)
       SELECT t.org_id, 'task.overdue', 'task', t.id,
              jsonb_build_object(
                'taskId', t.id, 'dealId', t.deal_id, 'contactId', t.contact_id,
                'accountId', t.account_id, 'taskAssigneeUserId', t.assignee_user_id,
                'idleDays', (current_date - t.due_on)
              ),
              'task.overdue:' || t.id || ':' || to_char(now(), 'YYYY-MM-DD')
         FROM tasks t
        WHERE t.org_id = $1 AND t.status = 'open'
          AND t.due_on IS NOT NULL AND t.due_on < current_date
       ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [rule.org_id],
    );
    queued += rowCount ?? 0;
  }

  // A promised callback (outreach_journey_steps.due_at) passed unactioned.
  // Same shape as task.overdue above: query everything overdue at all, one
  // event per step per day, and let each rule's own `graceHours` condition
  // (checked in matchesConditions) decide whether THIS rule cares yet.
  const { rows: outreachOverdueRules } = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM automation_rules
      WHERE trigger = 'outreach_step.overdue' AND status = 'active'`,
  );
  for (const rule of outreachOverdueRules) {
    const { rowCount } = await pool.query(
      `INSERT INTO automation_events (org_id, trigger, subject_type, subject_id, payload, dedupe_key)
       SELECT ojs.org_id, 'outreach_step.overdue', 'outreach_step', ojs.id,
              jsonb_build_object(
                'dealId', oj.deal_id, 'contactId', oj.contact_id,
                'journeyOwnerUserId', oj.owner_user_id,
                'overdueHours', floor(EXTRACT(EPOCH FROM (now() - ojs.due_at)) / 3600)
              ),
              'outreach_step.overdue:' || ojs.id || ':' || to_char(now(), 'YYYY-MM-DD')
         FROM outreach_journey_steps ojs
         JOIN outreach_journeys oj ON oj.id = ojs.journey_id
        WHERE ojs.org_id = $1 AND ojs.status = 'due'
          AND ojs.due_at < now()
       ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [rule.org_id],
    );
    queued += rowCount ?? 0;
  }

  return queued;
}

/**
 * Drain often, sweep rarely.
 *
 * A person moving a card expects the rule to have run by the time they look
 * again, so the queue is drained on a short clock. A deadline passing is a
 * daily-scale fact, and sweeping it every fifteen seconds would be a
 * full-table scan in exchange for nothing.
 */
export function startAutomationEngine(): { drain: NodeJS.Timeout; sweep: NodeJS.Timeout } {
  const drainMs = Number(process.env.AUTOMATION_DRAIN_MS);
  const sweepMs = Number(process.env.AUTOMATION_SWEEP_MS);

  return {
    drain: setInterval(
      () => void drainAutomationEvents().catch((err) => console.error("automation drain:", err)),
      Number.isFinite(drainMs) && drainMs > 0 ? drainMs : 15_000,
    ),
    sweep: setInterval(
      () => void sweepAutomationTriggers().catch((err) => console.error("automation sweep:", err)),
      Number.isFinite(sweepMs) && sweepMs > 0 ? sweepMs : 3_600_000,
    ),
  };
}
