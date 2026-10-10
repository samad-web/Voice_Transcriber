import { describe, expect, it } from "vitest";
import type { OwnerRecordScope } from "@aura/shared";
import type { PoolClient } from "@aura/db";
import {
  assertSubjectStillVisible,
  narrowerOwnerScope,
  resolvedScopeFor,
  SubjectNoLongerVisibleError,
} from "./export-scope";

/**
 * RE-AUTHORIZING A PERSON EXPORT AT RENDER TIME (0188, doc 35 §4.2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS SUITE IS THE ONE THAT MATTERS FOR THIS FEATURE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every other check on a person export happens in the API, synchronously,
 * while somebody is looking at a screen. This one happens minutes or hours
 * later, in a different process, with nobody watching - and it is the only
 * check that can see a reporting line that changed in between.
 *
 * The failure it prevents is specific and bad: a manager requests one of their
 * team's files, the person is moved to another branch (or the manager is
 * demoted) while the job sits in the queue, and the file renders anyway. The
 * requester then holds data about somebody they are no longer responsible for,
 * delivered AFTER somebody decided they should not have it.
 *
 * So each case below is a way that could go wrong, and the assertion is always
 * that it REFUSES rather than falls back.
 */

const flat = (sql: string) => sql.replace(/\s+/gu, " ").trim();

function fakeClient(answer: (sql: string, params: unknown[]) => Record<string, unknown>[]) {
  const log: string[] = [];
  const client = {
    async query<R>(sql: string, params: unknown[] = []) {
      log.push(flat(sql));
      return { rows: answer(flat(sql), params) as R[] };
    },
  } as unknown as PoolClient;
  return { client, log };
}

const ME = "11111111-1111-4111-8111-111111111111";
const MY_TC = "1aaaaaaa-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";
const THEIR_TC = "2aaaaaaa-2222-4222-8222-222222222222";

const manager = (): OwnerRecordScope => ({
  role: "manager",
  scope: "all",
  userId: ME,
  telecallerId: MY_TC,
});

const telecaller = (): OwnerRecordScope => ({
  role: "telecaller",
  scope: "own",
  userId: ME,
  telecallerId: MY_TC,
});

const isBranch = (sql: string) => sql.includes("WITH RECURSIVE my_seats");
const isOwn = (sql: string) => sql.startsWith("SELECT id FROM telecallers");

describe("assertSubjectStillVisible", () => {
  it("passes when the subject is still in the requester's branch", async () => {
    const { client } = fakeClient((sql) =>
      isBranch(sql) ? [{ user_id: THEM, telecaller_id: THEIR_TC }] : [{ id: MY_TC }],
    );
    await expect(assertSubjectStillVisible(client, manager(), THEIR_TC)).resolves.toBeUndefined();
  });

  /** The headline case: moved out of the branch between enqueue and render. */
  it("refuses when the subject has left the requester's branch", async () => {
    const { client } = fakeClient((sql) =>
      // The branch no longer contains THEIR_TC - only the manager themselves.
      isBranch(sql) ? [{ user_id: ME, telecaller_id: MY_TC }] : [{ id: MY_TC }],
    );
    await expect(assertSubjectStillVisible(client, manager(), THEIR_TC)).rejects.toThrow(
      SubjectNoLongerVisibleError,
    );
    await expect(assertSubjectStillVisible(client, manager(), THEIR_TC)).rejects.toThrow(
      /may no longer see that person's work/,
    );
  });

  it("refuses when the requester has been demoted to a telecaller", async () => {
    // The persona comes from the FRESH read, so a demotion between enqueue and
    // render arrives here as a different `role` - and a telecaller may only
    // ever see themselves.
    const { client } = fakeClient((sql) => (isOwn(sql) ? [{ id: MY_TC }] : []));
    await expect(assertSubjectStillVisible(client, telecaller(), THEIR_TC)).rejects.toThrow(
      SubjectNoLongerVisibleError,
    );
  });

  it("refuses when the requester has left the workspace", async () => {
    // `readOwnerScope` returns a telecaller own-scope with a null identity for
    // a departed member, so the fresh scope that reaches here matches nothing.
    const departed: OwnerRecordScope = {
      role: "telecaller",
      scope: "own",
      userId: ME,
      telecallerId: null,
    };
    const { client } = fakeClient(() => []);
    await expect(assertSubjectStillVisible(client, departed, THEIR_TC)).rejects.toThrow(
      SubjectNoLongerVisibleError,
    );
  });

  it("refuses when the manager's seat is gone, rather than widening", async () => {
    // An empty subtree falls back to the manager's OWN records. The dangerous
    // reading - "no restriction found, so no restriction" - would let a
    // manager whose seat was ended export anybody.
    const { client } = fakeClient((sql) => (isOwn(sql) ? [{ id: MY_TC }] : []));
    await expect(assertSubjectStillVisible(client, manager(), THEIR_TC)).rejects.toThrow(
      SubjectNoLongerVisibleError,
    );
    // ...and they can still export themselves, which is the correct fallback.
    const { client: c2 } = fakeClient((sql) => (isOwn(sql) ? [{ id: MY_TC }] : []));
    await expect(assertSubjectStillVisible(c2, manager(), MY_TC)).resolves.toBeUndefined();
  });

  it("lets an owner through without consulting the chart", async () => {
    const { client, log } = fakeClient(() => []);
    const owner: OwnerRecordScope = {
      role: "owner",
      scope: "all",
      userId: ME,
      telecallerId: null,
    };
    await expect(assertSubjectStillVisible(client, owner, THEIR_TC)).resolves.toBeUndefined();
    // No query at all: an owner's answer does not depend on the org chart, and
    // an unfilled chart must not narrow them.
    expect(log).toEqual([]);
  });

  it("lets a telecaller export themselves", async () => {
    // The right-of-access case. The feature has to work for the person whose
    // data it is, or "export my own data" needs a second mechanism.
    const { client } = fakeClient((sql) => (isOwn(sql) ? [{ id: MY_TC }] : []));
    await expect(assertSubjectStillVisible(client, telecaller(), MY_TC)).resolves.toBeUndefined();
  });

  it("does not re-read the membership, so it cannot pick a different persona", async () => {
    // `readOwnerScope` carries a load-bearing ORDER BY - a person can hold an
    // org-scope membership and workspace-scope rows at once. Taking the
    // already-resolved scope is what keeps this check and the rest of the job
    // running under ONE persona.
    const { client, log } = fakeClient((sql) =>
      isBranch(sql) ? [{ user_id: THEM, telecaller_id: THEIR_TC }] : [{ id: MY_TC }],
    );
    await assertSubjectStillVisible(client, manager(), THEIR_TC);
    expect(log.some((sql) => sql.includes("FROM memberships"))).toBe(false);
  });
});

describe("resolvedScopeFor with a subject", () => {
  it("defaults the subject to null, so the other scopes are unchanged", () => {
    // 0188 must be invisible to `view`, `section` and `bulk`.
    expect(resolvedScopeFor(manager(), null).subject).toBeNull();
  });

  it("carries the subject without touching the requester's own axes", () => {
    const subject = { telecallerId: THEIR_TC, userId: THEM };
    const resolved = resolvedScopeFor(telecaller(), "owned", subject);
    expect(resolved.owner).toEqual(telecaller());
    expect(resolved.crmUserId).toBe(ME);
    expect(resolved.subject).toEqual(subject);
  });
});

describe("narrowerOwnerScope, with a person export in mind", () => {
  it("still takes the narrower of snapshot and fresh", () => {
    // Unchanged by 0188, asserted here because a person export relies on it:
    // the subject narrows ON TOP of this, never instead of it.
    const snapshot: OwnerRecordScope = { ...manager(), scope: "all" };
    const fresh: OwnerRecordScope = { ...telecaller(), scope: "own" };
    expect(narrowerOwnerScope(snapshot, fresh).scope).toBe("own");
  });
});
