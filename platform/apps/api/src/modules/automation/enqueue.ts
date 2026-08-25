import type { AutomationSubject, AutomationTrigger } from "@aura/shared";

/**
 * Put one thing-that-happened on the automation queue (migration 0049).
 *
 * This is the API's ENTIRE involvement in Layer 2. One INSERT, then the
 * request returns; the worker decides whether any rule cares. That keeps a
 * tenant's own configuration off the critical path of every console action —
 * a rule with four actions must not make dragging a card slower, and a rule
 * that throws must not turn a successful stage change into a 500 the user has
 * to interpret.
 *
 * `subject` is captured NOW, not looked up later. A rule about "moved out of
 * Negotiation" needs the stage it moved out of, and by the time the worker
 * runs, the deal row no longer remembers it.
 */

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

export async function enqueueAutomationEvent(
  client: Queryable,
  orgId: string,
  trigger: AutomationTrigger,
  subjectType: "deal" | "contact" | "task" | "interaction",
  subjectId: string,
  subject: AutomationSubject,
): Promise<void> {
  await client.query(
    `INSERT INTO automation_events (org_id, trigger, subject_type, subject_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [orgId, trigger, subjectType, subjectId, JSON.stringify(subject)],
  );
}

/**
 * The same, but never allowed to break the caller.
 *
 * Every call site is a user-facing mutation that has already succeeded by the
 * time this runs. A queue insert failing is worth logging and worth nothing
 * else — the alternative is a rep whose stage change 500s because of a rule
 * they have never heard of. Same contract as `projectLeadToCrm`'s try/catch
 * in the worker pipeline, for the same reason.
 */
export async function enqueueAutomationEventSafely(
  client: Queryable,
  orgId: string,
  trigger: AutomationTrigger,
  subjectType: "deal" | "contact" | "task" | "interaction",
  subjectId: string,
  subject: AutomationSubject,
): Promise<void> {
  try {
    await enqueueAutomationEvent(client, orgId, trigger, subjectType, subjectId, subject);
  } catch (err) {
    console.error(`automation enqueue (${trigger}) failed:`, err);
  }
}
