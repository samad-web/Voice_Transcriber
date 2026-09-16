import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MERGE_REFERENCES, NOT_REPOINTED, type MergeObjectType } from "./merge-references";

/**
 * A merge used to repoint `deals` and leave every other reference on the
 * merged-away record (doc 23, D1). The fix is a list, and a list rots the day
 * a migration adds a column nobody remembered to add to it.
 *
 * So this reads the migrations themselves - no database needed - and fails for
 * any column that REFERENCES contacts/accounts without being either moved by a
 * merge or explicitly excused with a reason.
 */

const MIGRATIONS = join(__dirname, "..", "..", "..", "..", "..", "packages", "db", "migrations");
const TARGET: Record<MergeObjectType, string> = { contact: "contacts", account: "accounts" };

/** Every `table.column` declared as REFERENCES <target>(...) across all migrations. */
function referencesTo(target: string): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    let table: string | null = null;
    for (const line of readFileSync(join(MIGRATIONS, file), "utf8").split(/\r?\n/)) {
      const created = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_.]+)/i.exec(line);
      const altered = /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([a-z_.]+)/i.exec(line);
      if (created) table = created[1];
      else if (altered) table = altered[1];
      const column = new RegExp(`(?:ADD COLUMN (?:IF NOT EXISTS )?)?\\b([a-z_]+)\\s+uuid\\b[^,;]*REFERENCES ${target}\\(`, "i").exec(line);
      if (column && table) found.add(`${table}.${column[1]}`);
    }
  }
  return [...found].sort();
}

describe("merge reference coverage", () => {
  for (const objectType of ["contact", "account"] as const) {
    it(`moves or explicitly excuses every column that references ${TARGET[objectType]}`, () => {
      const declared = referencesTo(TARGET[objectType]);
      // Guard against the scan itself breaking and trivially passing.
      expect(declared.length).toBeGreaterThan(3);

      const handled = new Set([
        ...MERGE_REFERENCES[objectType].map((r) => `${r.table}.${r.column}`),
        ...NOT_REPOINTED[objectType].map((r) => `${r.table}.${r.column}`),
      ]);
      const unhandled = declared.filter((ref) => !handled.has(ref));
      expect(unhandled).toEqual([]);
    });

    it(`lists nothing for ${TARGET[objectType]} that no migration declares`, () => {
      // A stale entry would make the merge UPDATE a column that does not exist.
      const declared = new Set(referencesTo(TARGET[objectType]));
      const stale = MERGE_REFERENCES[objectType]
        .map((r) => `${r.table}.${r.column}`)
        .filter((ref) => !declared.has(ref));
      expect(stale).toEqual([]);
    });
  }

  it("gives a composite-key reference the key it conflicts on", () => {
    for (const refs of Object.values(MERGE_REFERENCES)) {
      for (const ref of refs.filter((r) => r.kind === "pair")) {
        expect([ref.table, ref.key]).toEqual([ref.table, expect.any(String)]);
      }
    }
  });
});
