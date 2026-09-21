import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { retirePersonalChannel, threadViewerOf, visibleThread } from "./private-threads";

/**
 * THE PRIVATE-THREAD RULE, ENFORCED (migration 0125).
 *
 * A read path that forgets `visibleThread` compiles, passes every other test,
 * and shows one rep's own WhatsApp chats to the rest of the team. Nothing
 * about that failure is visible in a diff - the query looks like every query
 * next to it - so it is a test: every API source file that queries the
 * conversation tables must either use the helper or be named below with the
 * reason it may read without it.
 *
 * Adding a file to the allowlist is a decision someone should be able to find
 * later, which is why each entry carries its reason rather than being a bare
 * path.
 */

const SRC = join(__dirname, "..");

/** Reads that are safe WITHOUT the viewer predicate, and why. */
const ALLOWLIST: Record<string, string> = {
  "modules/conversations/conversations.service.ts":
    "ingest WRITES the thread (stamping private_to_user_id) and reads back only its assignee to notify about an opt-out",
  "modules/owner/staff-performance.controller.ts":
    "counts replies per person for the scorecard; no thread, peer or message text is selected",
  "modules/tenancy/erasure.controller.ts":
    "erasure must reach every thread about the person being erased, private or not - it deletes, it does not display",
};

const QUERIES_CONVERSATIONS = /\b(FROM|JOIN|UPDATE|INTO)\s+(conversations|conversation_messages)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(SRC, path).split(sep).join("/");

describe("private threads (0125)", () => {
  const readers = sourceFiles(SRC).filter((f) => QUERIES_CONVERSATIONS.test(readFileSync(f, "utf8")));

  it("finds the conversation readers at all (the scan is not silently empty)", () => {
    expect(readers.length).toBeGreaterThanOrEqual(5);
  });

  it("every API file that queries conversations applies the viewer predicate or is allowlisted", () => {
    const offenders = readers
      .map(rel)
      .filter((f) => !(f in ALLOWLIST))
      .filter((f) => !readFileSync(join(SRC, f), "utf8").includes("common/private-threads"));
    expect(offenders).toEqual([]);
  });

  it("the allowlist names only files that still exist and still query conversations", () => {
    const current = new Set(readers.map(rel));
    for (const file of Object.keys(ALLOWLIST)) expect([file, current.has(file)]).toEqual([file, true]);
  });

  it("builds a predicate that admits shared threads and the viewer's own private ones", () => {
    expect(visibleThread("c", 3)).toBe(
      "(c.private_to_user_id IS NULL OR c.private_to_user_id = $3::uuid)",
    );
    expect(visibleThread("", 2)).toBe("(private_to_user_id IS NULL OR private_to_user_id = $2::uuid)");
  });

  it("resolves no viewer for a caller without a person behind it", () => {
    const id = "5b1f7a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(threadViewerOf({ principal: { userId: id } } as never)).toBe(id);
    expect(threadViewerOf({ principal: { userId: null } } as never)).toBeNull();
    expect(threadViewerOf({ principal: undefined } as never)).toBeNull();
    // A header value that is not a uuid must not become a viewer - it would
    // bind as a string and match nothing, but failing closed here is cheaper
    // than relying on that.
    expect(threadViewerOf({ principal: { userId: "dev-admin" } } as never)).toBeNull();
  });

  it("retiring a member disables only their own personal channel in this org", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    await retirePersonalChannel(
      { query: async (sql: string, params?: unknown[]) => void calls.push({ sql, params }) },
      "org-1",
      "user-1",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/UPDATE messaging_channels\s+SET status = 'disabled'/);
    expect(calls[0].sql).toMatch(/org_id = \$1 AND owner_user_id = \$2/);
    expect(calls[0].params).toEqual(["org-1", "user-1"]);
  });
});
