import { Injectable } from "@nestjs/common";
import { IMPORT_MAX_ROWS } from "@aura/shared";
import { importPhone } from "@aura/shared/dist/import-phone";
import type { CountryCode } from "@aura/shared/dist/phone";
import { numberKeyFor, type Queryable } from "./vault.service";

/**
 * DNC BULK INGEST (migration 0158 §4.2) - a sheet of numbers becomes keys, and
 * `entry_count` is made true again in the same transaction.
 *
 * ── THE KEY IS THE WHOLE PROBLEM ────────────────────────────────────────────
 *
 * `dnc_entries` stores `number_key` and never a number, so a row that keys
 * differently from the vault's row for the same customer is not a weak
 * suppression - it is NO suppression, silently, with a convincing count beside
 * it. A tenant uploads the national registry, the preview says "211 on a DNC
 * list", and the 40,000 that keyed wrong get rung anyway.
 *
 * So there is exactly one keying rule in this subsystem, `numberKeyFor` =
 * `sha256(phoneMatchDigits(n))`, and this file does not have its own. It also
 * does not have its own parser: a sheet arrives mixing `+91…`, `0…` and bare
 * ten-digit cells, and `importPhone` (packages/shared/src/import-phone.ts) is
 * already the function that reads those three the way the console's phone
 * field reads them, including the two ways Excel mangles a number. It was
 * written because the importer used to hash the digits as typed and every
 * imported contact hashed differently from the same person's lead; that is the
 * identical failure in a different table.
 *
 * NORMALISE FIRST, THEN KEY - AND THE REASON IS REFUSAL, NOT RE-SPELLING.
 * `phoneMatchDigits` takes the last ten digits, so it already keys
 * "+919876543210", "09876543210" and "9876543210" identically; running the
 * cell through `importPhone` first does not change those. What it changes is
 * what happens to a cell that is NOT a number. Seven digits is above
 * `phoneMatchDigits`' six-digit floor, so "1234567" keys to a perfectly
 * good-looking digest for something nobody can ring - an entry that matches
 * nobody, counted in `entry_count`, and reported to a supervisor as
 * suppression. `importPhone` refuses it instead, with the reason, for that
 * row. An entry that never matches is worse than a rejected row, because
 * nobody is told about the first one.
 *
 * ── WHY A REQUEST IS CAPPED AND A LIST IS NOT ───────────────────────────────
 *
 * §6 asks for a 40,000-row upload to produce 40,000 keyed entries. It does -
 * in chunks. The API's global JSON body limit is 1 MB and the ONE route
 * exempted from it is `POST /v1/import/run` (import-body-limit.ts), so a
 * single 40k-cell body is not a shape this process accepts, and widening the
 * global cap to suit one route is the thing that file exists to avoid. Entries
 * therefore append: the console posts `IMPORT_MAX_ROWS` at a time to the same
 * list, and because every chunk reconciles the count from `count(*)` rather
 * than adding its own total, the number is correct after the last one whatever
 * order they land in or how many are retried.
 */

/**
 * Numbers per request. The importer's own row limit, reused rather than
 * reinvented so one number governs both bulk paths.
 */
export const DNC_MAX_NUMBERS_PER_REQUEST = IMPORT_MAX_ROWS;

/**
 * The longest a cell may be and still be WORTH READING as a phone number.
 *
 * Enforced per row in `normaliseDncNumbers` below, deliberately NOT in the
 * route's zod body. That distinction is the whole point of this constant:
 *
 * A tenant who exports the wrong column gets a sheet where every cell is a
 * sentence. With the cap in the body schema, one such cell makes the WHOLE
 * 5,000-row chunk a 400 with a zod issue and no `failed` array - so the
 * console can say "that batch failed" and nothing else, and 4,999 perfectly
 * good numbers are lost with it. Refused per row, the same sheet comes back
 * as "4,999 added, 1 refused: that is not a phone number", which is a sentence
 * somebody can act on.
 *
 * The body schema keeps a much larger cap (`DNC_MAX_CELL_BYTES`) which exists
 * only to bound the payload, not to judge the content.
 */
export const DNC_MAX_CELL_CHARS = 40;

/**
 * The payload bound, as distinct from the semantic one above. 5,000 rows x 500
 * chars is ~2.5 MB worst case, which sits inside the body limit the import
 * routes already assume. A cell longer than this is not a misfiled column, it
 * is abuse, and refusing the request outright is the right answer for it.
 */
export const DNC_MAX_CELL_BYTES = 500;

export interface DncRowFailure {
  /** Index in the posted array, so the console can point at the sheet row. */
  index: number;
  value: string;
  error: string;
}

export interface DncNormalisation {
  /** Distinct keys, in first-seen order. */
  keys: string[];
  /** Cells that keyed to something already in this same batch. */
  duplicatesInSheet: number;
  /** Empty cells. A blank line in a sheet is noise, not an error. */
  blank: number;
  failed: DncRowFailure[];
}

/**
 * A sheet's phone cells as vault-compatible keys.
 *
 * Pure: no database, no clock. The three mixed formats §4.2 names are the
 * cases `dnc-import.service.spec.ts` pins, and they are pinned by asserting
 * all three produce the SAME key - not by asserting what that key is, which
 * would only restate the hash.
 */
export function normaliseDncNumbers(
  numbers: readonly string[],
  country: CountryCode,
): DncNormalisation {
  const seen = new Set<string>();
  const keys: string[] = [];
  const failed: DncRowFailure[] = [];
  let duplicatesInSheet = 0;
  let blank = 0;

  numbers.forEach((raw, index) => {
    const value = (raw ?? "").trim();
    if (!value) {
      blank += 1;
      return;
    }

    // Per row, not at the body schema - see DNC_MAX_CELL_CHARS. The message is
    // the same one importPhone gives for junk, because from the uploader's side
    // it is the same mistake: this cell is not a phone number. Truncated in the
    // report so a refused sentence does not paste a paragraph into the console.
    if (value.length > DNC_MAX_CELL_CHARS) {
      failed.push({
        index,
        value: `${value.slice(0, DNC_MAX_CELL_CHARS)}…`,
        error: "that is not a phone number.",
      });
      return;
    }

    const read = importPhone(value, country);
    if (!read.ok) {
      failed.push({ index, value, error: read.message });
      return;
    }
    // `ok` with a null number means the cell was blank, which the guard above
    // already took; anything else reaching here is a real E.164.
    if (!read.e164) {
      blank += 1;
      return;
    }

    const key = numberKeyFor(read.e164);
    if (!key) {
      // Unreachable in practice - importPhone refuses below six digits - but a
      // key that cannot be computed must never become a silent empty string.
      failed.push({ index, value, error: "too few digits to match on." });
      return;
    }
    if (seen.has(key)) {
      duplicatesInSheet += 1;
      return;
    }
    seen.add(key);
    keys.push(key);
  });

  return { keys, duplicatesInSheet, blank, failed };
}

/** `SELECT ... FOR UPDATE` on the list, so two chunks of one upload cannot race the reconcile. */
export const DNC_LOCK_LIST_SQL = `SELECT id, status FROM dnc_lists WHERE id = $1 FOR UPDATE`;

/** The bulk insert. One statement for the whole chunk; already-present keys are not an error. */
export const DNC_INSERT_ENTRIES_SQL = `INSERT INTO dnc_entries (list_id, org_id, number_key)
     SELECT $1::uuid, $2::uuid, k FROM unnest($3::text[]) AS k
     ON CONFLICT (list_id, number_key) DO NOTHING`;

/**
 * The reconcile. `count(*)`, never `entry_count + n`.
 *
 * Nothing in 0158's schema keeps this column true - no trigger, no generated
 * column - and the campaign preview reports off it, so the import service owns
 * it. Recomputing beats incrementing for the reason every retried upload
 * demonstrates: `ON CONFLICT DO NOTHING` makes the insert idempotent, and an
 * increment of "rows I was handed" is not.
 */
export const DNC_RECONCILE_COUNT_SQL = `UPDATE dnc_lists
        SET entry_count = (SELECT count(*) FROM dnc_entries e WHERE e.list_id = dnc_lists.id)
      WHERE id = $1
      RETURNING entry_count`;

export interface DncIngestResult {
  /** Keys that were not already on this list. */
  inserted: number;
  /** Keys already present - a re-uploaded sheet, or an overlap with an earlier chunk. */
  alreadyPresent: number;
  /** The reconciled `dnc_lists.entry_count`, as the row now holds it. */
  entryCount: number;
}

@Injectable()
export class DncImportService {
  /**
   * Insert a chunk of keys and make the list's count true, in this order:
   * lock, insert, reconcile.
   *
   * MUST be called inside `withOrg` - which is itself one transaction
   * (`withOrgContext` opens BEGIN and commits when the callback returns), so
   * "reconciled in the same transaction as the bulk insert" is satisfied by
   * doing both inside one callback and nothing else is needed. A second
   * `withOrg` for the count would be a second transaction and could observe a
   * half-finished sibling.
   *
   * The lock is a plain statement rather than a CTE on purpose: a FOR UPDATE
   * inside a CTE is only taken if the planner evaluates that CTE, which is how
   * a lock that reads as taken turns out never to have been.
   */
  async ingest(
    client: Queryable,
    input: { orgId: string; listId: string; keys: readonly string[] },
  ): Promise<DncIngestResult> {
    await client.query(DNC_LOCK_LIST_SQL, [input.listId]);

    const keys = [...input.keys];
    let inserted = 0;
    if (keys.length > 0) {
      const { rowCount } = await client.query(DNC_INSERT_ENTRIES_SQL, [input.listId, input.orgId, keys]);
      inserted = rowCount ?? 0;
    }

    const {
      rows: [row],
    } = await client.query<{ entry_count: number }>(DNC_RECONCILE_COUNT_SQL, [input.listId]);

    return {
      inserted,
      alreadyPresent: keys.length - inserted,
      entryCount: Number(row?.entry_count ?? 0),
    };
  }
}
