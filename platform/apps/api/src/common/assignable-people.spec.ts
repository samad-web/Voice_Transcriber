import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A SUSPENDED COLLEAGUE IS NEVER OFFERED WORK (migration 0198).
 *
 * ── THE BUG THIS EXISTS TO STOP COMING BACK ───────────────────────────────
 *
 * `GET /tasks/assignable-people` listed every membership row in the org with
 * no status filter at all, so somebody who had been suspended three months
 * earlier sat in the "Assign to" picker looking exactly like a colleague at
 * their desk. The obvious thing to do with a task a departing rep left behind
 * was therefore to hand it straight back to the person who cannot sign in -
 * and nothing anywhere would say so.
 *
 * It is one clause. It compiles without it, every other test passes without
 * it, and the failure is invisible in a diff: a picker is a list, and a list
 * with one extra name in it looks like a list.
 *
 * ── WHY A SOURCE SCAN AND NOT A REQUEST TEST ──────────────────────────────
 *
 * A request test would need a database with a suspended member in it. That is
 * the tenant-isolation suite, which needs a container, is opt-in, and
 * therefore rots - a case that 403s before it reaches the handler still looks
 * like coverage. This runs in the unit suite on every `pnpm test`, costs a
 * file read, and fails with the name of the query that lost its filter.
 *
 * ── AND WHY THE ROSTER IS LISTED AS AN EXCEPTION ──────────────────────────
 *
 * Because it is one, deliberately, and somebody adding a filter to it "for
 * consistency" would break reinstatement: the Staff page is the only screen
 * that can bring a suspended person back, so it has to list them. Writing
 * that down beside the rule is the point of the allowlist.
 */

const SRC = join(__dirname, "..");

/** The pickers: a query whose result is offered to somebody as a choice. */
const PICKERS: Array<{ file: string; marker: string; why: string }> = [
  {
    file: "modules/tasks/tasks.controller.ts",
    marker: "assignable-people",
    why: "the task Assign-to picker",
  },
];

/** Reads that must list suspended people, and why. */
const LISTS_EVERYONE: Record<string, string> = {
  "modules/owner/owner-team.controller.ts":
    "the Staff roster. The only screen that can REINSTATE somebody, so hiding " +
    "them would make suspension irreversible from the console - and a roster " +
    "that silently dropped a colleague reads as 'removed', which is how a " +
    "second login gets created for a person who already has one.",
};

describe("assignable-people pickers", () => {
  for (const picker of PICKERS) {
    it(`${picker.why} excludes suspended members`, () => {
      const source = readFileSync(join(SRC, picker.file), "utf8");
      expect(source).toContain(picker.marker);
      // The clause itself, in the query that joins memberships to users. Not a
      // regex over the whole file: `m.status` appearing anywhere would pass
      // that, including in a comment explaining why it is missing.
      const query = source.slice(source.indexOf(picker.marker));
      const join_ = query.indexOf("FROM memberships m");
      expect(join_).toBeGreaterThan(-1);
      const where = query.slice(join_, join_ + 400);
      expect(where).toMatch(/m\.status = 'active'/);
    });
  }

  it("documents the reads that are meant to list everybody", () => {
    for (const [file, why] of Object.entries(LISTS_EVERYONE)) {
      expect(readFileSync(join(SRC, file), "utf8").length).toBeGreaterThan(0);
      expect(why.length).toBeGreaterThan(40);
    }
  });
});

/**
 * The other half of 0198, asserted where it cannot be quietly undone.
 *
 * `telecallers.status` had 'archived' from 0017 and no writer anywhere for a
 * hundred and eighty migrations, which is why a suspended rep kept collecting
 * round-robin leads. If these two calls ever disappear from suspend and
 * reinstate, the lead routing bug is back exactly as it was, and no test that
 * exercises routing would notice: the identity is active, so routing is right.
 */
describe("suspension archives the desk", () => {
  const controller = readFileSync(
    join(SRC, "modules/owner/owner-team.controller.ts"),
    "utf8",
  );

  it("suspend and reinstate both move telecallers.status", () => {
    expect(controller).toContain("setTelecallerArchived");
    // Symmetric: the flag is the status being written, so one call covers both
    // directions and neither can be forgotten on its own.
    expect(controller).toMatch(/setTelecallerArchived\(\s*client,\s*orgId,\s*userId,\s*status === "suspended"/);
  });

  it("suspension logs the handsets out, and reinstatement does not re-arm them", () => {
    expect(controller).toMatch(/status === "suspended"\s*\?\s*await this\.offboard\.logOutHandsets/);
  });

  it("removal refuses to strand open work unless it is forced", () => {
    expect(controller).toContain("?force=true");
    expect(controller).toMatch(/ConflictException\(/);
  });
});
