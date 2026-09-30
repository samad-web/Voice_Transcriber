import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * A call issue ticket may never carry CALL CONTENT (migration 0147, doc 36 §0).
 *
 * ── WHY THIS FILE IS THE WHOLE FEATURE'S SAFETY CATCH ───────────────────────
 *
 * Migration 0122 means a platform operator cannot read a tenant's transcript or
 * recording without a live, bounded grant from that tenant's own administrator.
 * The escalation queue is read by operators with NO such grant - that is
 * deliberate, because gating triage on a grant would make the queue unopenable in
 * exactly the orgs that care most.
 *
 * Which leaves one rule holding the two apart: a ticket describes a call, it never
 * quotes one. Break that and the queue becomes a side channel around 0122 -
 * reachable with no grant, filed by a MANAGER who under 0122 has no standing to
 * approve access at all, and nothing anywhere would fail.
 *
 * ── WHY IT READS SOURCE RATHER THAN CALLING THE API ─────────────────────────
 *
 * A live test would need a database, which puts it in the opt-in integration
 * suite - and `isolation-suite-drift` records what happens to assertions that
 * only run when somebody remembers to start docker. This runs in `pnpm test`, on
 * every laptop, every time. It is the same trade `guard-mounting.spec.ts` makes
 * by reflecting over metadata instead of issuing requests.
 *
 * It cannot prove the API's output is clean; it pins the four things that would
 * have to be true first for it not to be, each of which is a one-line edit away.
 */

const API_SRC = (() => {
  let dir = resolve(__dirname);
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(dir, "modules")) && existsSync(join(dir, "common"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find apps/api/src above ${__dirname}`);
})();

const OWNER_CONTROLLER = join(API_SRC, "modules", "owner", "owner-call-issues.controller.ts");
const ADMIN_CONTROLLER = join(API_SRC, "modules", "admin", "admin-call-issues.controller.ts");
const WORKER_FOLLOWUP = resolve(
  API_SRC,
  "..",
  "..",
  "worker",
  "src",
  "pipeline",
  "call-issue-followup.ts",
);

/** Source with `//` and `/* *​/` comments stripped - a rule about SQL must not be
 *  satisfied or broken by prose ABOUT the rule. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const FILES = [
  ["the client's controller", OWNER_CONTROLLER],
  ["the operator's controller", ADMIN_CONTROLLER],
  ["the worker's follow-up", WORKER_FOLLOWUP],
] as const;

describe("a call issue never carries call content (0147, doc 36 §0)", () => {
  it("reads the files it claims to - a scanner pointed at nothing would pass silently", () => {
    const problems: string[] = [];
    for (const [label, file] of FILES) {
      if (!existsSync(file)) problems.push(`${label} not found at ${file}`);
      else if (code(file).length < 500) problems.push(`${label} is empty after comment stripping`);
    }
    expect(problems).toEqual([]);
  });

  /**
   * The transcript may be MEASURED and DIGESTED. It may not be selected.
   *
   * `char_length(tr.text)` and `md5(tr.text)` answer "how long was it" and "did it
   * change" without the words leaving Postgres. Anything else touching `.text` on
   * a transcript alias is a column heading somewhere, and this is the assertion
   * that stops it.
   */
  it("touches a transcript's text only inside char_length() or md5()", () => {
    const problems: string[] = [];
    for (const [label, file] of FILES) {
      const sql = code(file);
      const all = [...sql.matchAll(/\b(?:t|tr|transcripts?)\.text\b/g)].length;
      const wrapped = [
        ...sql.matchAll(/\b(?:char_length|md5)\s*\(\s*(?:t|tr|transcripts?)\.text\s*\)/g),
      ].length;
      if (all !== wrapped) {
        problems.push(
          `${label}: ${all} reference(s) to a transcript's text, only ${wrapped} measured or digested`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  /** The other shapes content arrives in. A ticket needs none of them. */
  it("never reaches for a recording URL, an AI read, or a transcript segment", () => {
    const FORBIDDEN = [
      "presignedGetUrl",
      "presigned",
      "S3Service",
      // `transcripts.segments` is the diarized speaker turns - content, split up.
      ".segments",
      // These hold the summary and the extracted facts.
      "ai_outputs",
      "ci.summary",
      "ca.summary",
    ];
    const problems: string[] = [];
    for (const [label, file] of FILES) {
      const sql = code(file);
      for (const forbidden of FORBIDDEN) {
        if (sql.includes(forbidden)) problems.push(`${label} mentions ${forbidden}`);
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * The snapshot's recording column is a KEY, not a URL.
   *
   * A key is a pointer that still requires the gated presign route to become
   * access; a URL in a ticket would BE access, to anyone who can read the ticket.
   */
  it("declares no column that could hold call content", () => {
    const migration = (() => {
      let dir = resolve(__dirname);
      for (let up = 0; up < 8; up++) {
        const candidate = join(dir, "packages", "db", "migrations");
        if (existsSync(candidate)) return join(candidate, "0147_call_issue_escalation.sql");
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      throw new Error("migrations directory not found");
    })();
    const sql = readFileSync(migration, "utf8");
    expect(sql).toContain("snap_recording_s3_key");

    const columns = [...sql.matchAll(/^\s{2}([a-z_]+)\s+(?:text|jsonb)/gm)].map((m) => m[1]);
    expect(columns.length).toBeGreaterThan(10);
    expect(
      columns.filter((c) => /transcript_text|segments|summary|url|presign|body_text/.test(c)),
    ).toEqual([]);
  });
});

describe("internal notes stay internal", () => {
  /**
   * `call_issue_events.visibility` is the only thing between an operator's candid
   * note and the customer's console. Every read the CLIENT makes must filter on
   * it; the operator's own read must not (they need both halves), and asserting
   * BOTH directions is what stops a well-meaning refactor from sharing one query
   * between the two audiences.
   */
  it("filters the client's timeline to client-visible rows", () => {
    const owner = code(OWNER_CONTROLLER);
    const reads = [...owner.matchAll(/FROM call_issue_events[\s\S]*?(?=`)/g)].map((m) => m[0]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((r) => !/visibility\s*=\s*'client'/.test(r))).toEqual([]);
  });

  it("leaves the operator's timeline unfiltered - they need the internal rows too", () => {
    const admin = code(ADMIN_CONTROLLER);
    const reads = [...admin.matchAll(/FROM call_issue_events[\s\S]*?(?=`)/g)].map((m) => m[0]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((r) => /visibility\s*=\s*'client'/.test(r))).toEqual([]);
  });

  /** Everything the client's own controller writes is, by definition, theirs to see. */
  it("writes only client-visible events from the client's controller", () => {
    const owner = code(OWNER_CONTROLLER);
    const inserts = [...owner.matchAll(/INSERT INTO call_issue_events[\s\S]*?VALUES[^`]*/g)].map(
      (m) => m[0],
    );
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.filter((i) => !i.includes("'client'"))).toEqual([]);
    expect(inserts.filter((i) => i.includes("'internal'"))).toEqual([]);
  });
});
