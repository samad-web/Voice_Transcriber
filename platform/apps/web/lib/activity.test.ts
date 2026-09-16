import { describe, expect, it } from "vitest";
import {
  interactionActor,
  interactionToActivity,
  mergeActivity,
  messageToActivity,
  transitionToActivity,
  type InteractionRow,
} from "./activity";

const base: InteractionRow = {
  id: "i1",
  type: "note",
  direction: null,
  deal_id: null,
  call_id: null,
  subject: null,
  body: "Asked for a quote",
  occurred_at: "2026-09-15T10:00:00Z",
  duration_s: null,
  actor_user_id: null,
  actor: null,
  actor_label: null,
  connection_id: null,
};

/**
 * One case per writer of `interactions` (apps/web/lib/activity.ts header).
 * These are the rows the "automated vs human" label is read from, so each
 * writer's real column shape is pinned rather than a hand-picked few.
 */
describe("interactionActor - one case per writer", () => {
  it("a note a person logged in the console is human", () => {
    const row = { ...base, actor_user_id: "u1", actor: "Logesh" };
    expect(interactionActor(row, "Priya")).toEqual({ kind: "human", name: "Logesh", via: null });
    expect(interactionToActivity(row, { contactName: "Priya" }).summary).toBe("Logesh logged a note");
  });

  it("an automation rule's note is automated, however it is worded", () => {
    const row = { ...base, actor_label: "automation", actor: "automation" };
    expect(interactionActor(row, "Priya").kind).toBe("automated");
    expect(interactionToActivity(row, { contactName: "Priya" }).summary).toBe("Automation added a note");
  });

  it("a recorded call is the telecaller's - the handset only recorded it", () => {
    const row = { ...base, type: "call" as const, call_id: "c1", direction: "outgoing" as const, actor: "Logesh", actor_label: "Logesh", duration_s: 95 };
    const item = interactionToActivity(row, { contactName: "Priya" });
    expect(item.actor).toEqual({ kind: "human", name: "Logesh", via: "recorded on a handset" });
    expect(item.summary).toBe("Logesh called Priya");
    expect(interactionToActivity({ ...row, direction: "incoming" }, { contactName: "Priya" }).summary).toBe(
      "Logesh took a call from Priya",
    );
  });

  it("a call whose recording was deleted is still the telecaller's, not automated", () => {
    // Found on real data: calls.id is ON DELETE SET NULL on interactions, so a
    // reaped or erased recording leaves call_id null on a genuine call.
    const row = { ...base, type: "call" as const, call_id: null, direction: "outgoing" as const, actor: "ELI-NX9", actor_label: "ELI-NX9" };
    expect(interactionActor(row, "Priya")).toEqual({ kind: "human", name: "ELI-NX9", via: "recording no longer kept" });
    expect(interactionToActivity(row, { contactName: "Priya" }).summary).toBe("ELI-NX9 called Priya");
  });

  it("a hand-logged call is a person's, and says it is not a recording", () => {
    const row = {
      ...base,
      type: "call" as const,
      direction: "outgoing" as const,
      actor_user_id: "u1",
      actor: "Logesh",
      metadata: { logged_by_hand: true, outcome: "no_answer" },
    };
    expect(interactionActor(row, "Priya")).toEqual({
      kind: "human",
      name: "Logesh",
      via: "logged by hand - not a recording",
    });
    expect(interactionToActivity(row, { contactName: "Priya" }).summary).toBe(
      "Logesh logged a call to Priya - no answer",
    );
  });

  it("an incoming synced email is the contact writing", () => {
    const row = { ...base, type: "email" as const, direction: "incoming" as const, connection_id: "k1", actor_user_id: "u1", actor: "Logesh" };
    const item = interactionToActivity(row, { contactName: "Priya" });
    expect(item.actor.kind).toBe("contact");
    expect(item.summary).toBe("Priya sent an email");
  });

  it("an outgoing synced email or a console-sent one is the person who sent it", () => {
    const synced = { ...base, type: "email" as const, direction: "outgoing" as const, connection_id: "k1", actor_user_id: "u1", actor: "Logesh" };
    expect(interactionToActivity(synced, { contactName: "Priya" }).summary).toBe("Logesh sent an email");
    expect(interactionActor(synced, "Priya").kind).toBe("human");
  });

  it("a synced calendar meeting is human, marked as synced", () => {
    const row = { ...base, type: "meeting" as const, connection_id: "k1", actor_user_id: "u1", actor: "Logesh" };
    expect(interactionActor(row, "Priya")).toEqual({ kind: "human", name: "Logesh", via: "synced from a calendar" });
  });

  it("a row with nobody to attribute it to is never presented as a person", () => {
    expect(interactionActor(base, "Priya").kind).toBe("automated");
  });

  it("never prints an empty name", () => {
    const row = { ...base, actor_user_id: "u1", actor: null };
    expect(interactionToActivity(row, { contactName: null }).summary).toBe("A teammate logged a note");
  });
});

describe("messageToActivity", () => {
  const msg = { id: "m1", channel: "whatsapp", subject: null, body: "Is it available?", occurred_at: "2026-09-15T09:00:00Z" };

  it("an incoming message is the contact's", () => {
    const item = messageToActivity({ ...msg, direction: "incoming", sent_by_user_id: null }, { contactName: "Priya" });
    expect(item.actor.kind).toBe("contact");
    expect(item.summary).toBe("Priya sent a WhatsApp message");
  });

  it("an outgoing reply is the person who sent it, and stays human when unrecorded", () => {
    expect(
      messageToActivity({ ...msg, direction: "outgoing", sent_by_user_id: "u1", sent_by_name: "Logesh" }, { contactName: "Priya" }).summary,
    ).toBe("Logesh replied with a WhatsApp message");
    const unattributed = messageToActivity({ ...msg, direction: "outgoing", sent_by_user_id: null }, { contactName: "Priya" });
    expect(unattributed.actor).toEqual({ kind: "human", name: null, via: "sender not recorded" });
  });
});

describe("transitionToActivity", () => {
  const deal = { id: "d1", name: "Brick order" };
  const label = (k: string) => k[0].toUpperCase() + k.slice(1);
  const row = { id: "t1", from_stage: "new", to_stage: "contacted", occurred_at: "2026-09-15T08:00:00Z", actor: "Logesh" };

  it("separates a person's move from a rule's, the call projection's and a reconstruction", () => {
    expect(transitionToActivity({ ...row, source: "console" }, deal, label)).toMatchObject({
      actor: { kind: "human", name: "Logesh" },
      summary: "Logesh moved Brick order from New to Contacted",
    });
    expect(transitionToActivity({ ...row, source: "automation" }, deal, label).actor.kind).toBe("automated");
    expect(transitionToActivity({ ...row, source: "pipeline" }, deal, label).summary).toBe(
      "Call analysis moved Brick order from New to Contacted",
    );
    expect(transitionToActivity({ ...row, source: "backfill", from_stage: null }, deal, label)).toMatchObject({
      actor: { kind: "automated", via: "reconstructed, not observed" },
      summary: "Brick order was entered into Contacted",
    });
  });
});

describe("mergeActivity", () => {
  it("orders newest first across sources and drops duplicates", () => {
    const note = interactionToActivity({ ...base, actor_user_id: "u1", actor: "L", occurred_at: "2026-09-15T10:00:00Z" }, { contactName: null });
    const message = messageToActivity(
      { id: "m1", direction: "incoming", channel: "whatsapp", subject: null, body: "hi", sent_by_user_id: null, occurred_at: "2026-09-15T11:00:00Z" },
      { contactName: null },
    );
    expect(mergeActivity([note], [message], [note]).map((i) => i.key)).toEqual(["message:m1", "interaction:i1"]);
  });
});
