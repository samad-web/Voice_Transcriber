import { IMPORT_MAX_ROWS } from "@aura/shared";

/**
 * What an upload to a do-not-call list actually did - counted, and with every
 * refusal kept.
 *
 * ── WHY THE REFUSALS ARE THE WHOLE POINT ────────────────────────────────────
 *
 * `dnc-import.service.ts` returns a `failed` entry for every cell it could not
 * key, and its own header says why that is reported rather than counted: a row
 * that did not key is a person who will still be rung. A console that printed
 * "4,812 of 5,000 added" and swallowed the other 188 would be telling somebody
 * their registry is loaded while 188 of the people on it stay dialable. So the
 * reasons are rendered, grouped, with examples - and in the console's ERROR
 * tone, which is orange. Red means MISSED here (packages/ui/src/state.tsx).
 *
 * ── WHY ANY OF THIS IS A SEPARATE, PURE MODULE ──────────────────────────────
 *
 * Because of `index`. The API's `failed[].index` is an index into the array
 * THAT CHUNK posted, and a 40,000-row sheet is posted as eight chunks (the API
 * caps a request at `DNC_MAX_NUMBERS_PER_REQUEST`, and its own comment explains
 * that widening the global 1 MB body limit for one route is the thing it is
 * avoiding). Reporting that index as a sheet row makes every chunk after the
 * first point at the wrong line - plausibly, consistently, and with no symptom
 * at all except somebody opening their sheet at row 7 and finding a perfectly
 * good number there. The offset therefore lives in one function with a test on
 * it rather than inline in a component nothing executes.
 */

/**
 * Numbers per request. `DNC_MAX_NUMBERS_PER_REQUEST` in the API is this same
 * constant, so the console chunks to exactly what the route accepts and one
 * number governs both sides.
 */
export const UPLOAD_CHUNK = IMPORT_MAX_ROWS;

/**
 * The longest cell the route will take (`z.string().max(40)`).
 *
 * Enforced here as well, and that is not belt-and-braces: a single over-long
 * cell fails the body schema, so the API answers 400 for the WHOLE chunk and
 * reports nothing per row. Five thousand good numbers would be refused with one
 * validation message because a sheet had a sentence in it. Cells this long are
 * taken out before posting and reported as refusals of our own.
 */
export const MAX_CELL_CHARS = 40;

/** What this console says about a cell it removed before posting. */
export const TOO_LONG_REASON = `longer than ${MAX_CELL_CHARS} characters - not a phone number.`;

/** One refused cell, exactly as `dnc-import.service.ts` returns it. */
export interface DncRowFailure {
  /** Index in the posted array - of the CHUNK, never of the sheet. */
  index: number;
  value: string;
  /** libphonenumber's reason, via `importPhone`. Already a sentence. */
  error: string;
}

/** The body of `POST /v1/dnc/lists/:id/entries`. */
export interface DncAddEntriesResponse {
  /** Distinct keys the API accepted - `inserted` + `alreadyPresent`. */
  accepted: number;
  inserted: number;
  alreadyPresent: number;
  duplicatesInSheet: number;
  blank: number;
  /** `dnc_lists.entry_count`, reconciled in the insert's own transaction. */
  entryCount: number;
  failed: DncRowFailure[];
}

export interface RefusalExample {
  /** Index within the chunk. The caller turns it into a place in the sheet. */
  index: number;
  value: string;
}

export interface RefusalGroup {
  reason: string;
  count: number;
  examples: RefusalExample[];
}

/**
 * How many refused cells are quoted per reason.
 *
 * Counted in full, quoted in part. A sheet whose phone column is one off can
 * refuse every row, and forty thousand quoted cells is not a report - it is the
 * same sheet again. Four is enough to recognise what went in.
 */
export const REFUSAL_EXAMPLES = 4;

/** Refusals by reason, commonest first. */
export function groupFailures(failed: readonly DncRowFailure[]): RefusalGroup[] {
  const byReason = new Map<string, RefusalGroup>();
  for (const row of failed) {
    // A reason is what makes this worth rendering; an empty one would collapse
    // every unexplained refusal into a blank heading.
    const reason = row.error.trim() || "refused, with no reason given.";
    let group = byReason.get(reason);
    if (!group) {
      group = { reason, count: 0, examples: [] };
      byReason.set(reason, group);
    }
    group.count += 1;
    if (group.examples.length < REFUSAL_EXAMPLES) {
      group.examples.push({ index: row.index, value: row.value });
    }
  }
  // Commonest first, then by reason, so two runs of the same sheet read the
  // same way round.
  return [...byReason.values()].sort(
    (a, b) => b.count - a.count || a.reason.localeCompare(b.reason),
  );
}

/**
 * One chunk's answer, small enough to cross a Server Action boundary.
 *
 * The raw `failed` array is grouped on the server side rather than shipped: a
 * chunk can refuse all 5,000 of its cells, and the browser has no use for the
 * 4,980 it will never print.
 */
export interface DncChunkSummary {
  inserted: number;
  alreadyPresent: number;
  duplicatesInSheet: number;
  blank: number;
  entryCount: number;
  refused: number;
  groups: RefusalGroup[];
}

export function summariseChunk(body: DncAddEntriesResponse): DncChunkSummary {
  return {
    inserted: body.inserted,
    alreadyPresent: body.alreadyPresent,
    duplicatesInSheet: body.duplicatesInSheet,
    blank: body.blank,
    entryCount: body.entryCount,
    refused: body.failed.length,
    groups: groupFailures(body.failed),
  };
}

export interface UploadRefusal {
  reason: string;
  count: number;
  /** Up to `REFUSAL_EXAMPLES` cells, each said to be somewhere in the sheet. */
  examples: { where: string; value: string }[];
}

/** Every chunk of one upload, added up. */
export interface UploadTally {
  /** Cells this console handed over, including the ones it refused itself. */
  submitted: number;
  inserted: number;
  alreadyPresent: number;
  duplicatesInSheet: number;
  blank: number;
  refused: number;
  /** The list's count as the LAST chunk reconciled it - never a running sum. */
  entryCount: number;
  refusals: UploadRefusal[];
}

export const EMPTY_TALLY: UploadTally = {
  submitted: 0,
  inserted: 0,
  alreadyPresent: 0,
  duplicatesInSheet: 0,
  blank: 0,
  refused: 0,
  entryCount: 0,
  refusals: [],
};

/** Fold one group into a list of refusals that is being accumulated. */
function foldGroup(
  into: UploadRefusal[],
  reason: string,
  count: number,
  examples: readonly { where: string; value: string }[],
): void {
  let seen = into.find((r) => r.reason === reason);
  if (!seen) {
    seen = { reason, count: 0, examples: [] };
    into.push(seen);
  }
  seen.count += count;
  for (const example of examples) {
    if (seen.examples.length >= REFUSAL_EXAMPLES) break;
    seen.examples.push(example);
  }
}

function sorted(refusals: UploadRefusal[]): UploadRefusal[] {
  return [...refusals].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** A copy of `tally`'s refusals that can be added to without mutating it. */
function clone(tally: UploadTally): UploadRefusal[] {
  return tally.refusals.map((r) => ({ ...r, examples: [...r.examples] }));
}

/**
 * Add one posted chunk to the running tally.
 *
 * `where` is given the index WITHIN THE CHUNK and answers where that cell was
 * in the sheet; the caller is the only thing that knows the chunk's offset, so
 * it is the only thing that can close over it. `entryCount` is taken from the
 * chunk rather than accumulated - the API recomputes it with `count(*)` in the
 * insert's own transaction, so the newest one is the truth and adding them up
 * would multiply the list's size by the number of chunks.
 */
export function mergeChunk(
  tally: UploadTally,
  chunk: DncChunkSummary,
  submitted: number,
  where: (indexInChunk: number) => string,
): UploadTally {
  const refusals = clone(tally);
  for (const group of chunk.groups) {
    foldGroup(
      refusals,
      group.reason,
      group.count,
      group.examples.map((e) => ({ where: where(e.index), value: e.value })),
    );
  }
  return {
    submitted: tally.submitted + submitted,
    inserted: tally.inserted + chunk.inserted,
    alreadyPresent: tally.alreadyPresent + chunk.alreadyPresent,
    duplicatesInSheet: tally.duplicatesInSheet + chunk.duplicatesInSheet,
    blank: tally.blank + chunk.blank,
    refused: tally.refused + chunk.refused,
    entryCount: chunk.entryCount,
    refusals: sorted(refusals),
  };
}

/**
 * Refusals this console made itself, before anything was posted.
 *
 * They count as submitted and as refused, exactly like the API's own: from the
 * reader's side a cell that was never sent and a cell that came back rejected
 * are the same event - a number in their sheet that is not on the list.
 */
export function addLocalRefusals(
  tally: UploadTally,
  reason: string,
  cells: readonly { where: string; value: string }[],
): UploadTally {
  if (cells.length === 0) return tally;
  const refusals = clone(tally);
  foldGroup(refusals, reason, cells.length, cells.slice(0, REFUSAL_EXAMPLES));
  return {
    ...tally,
    submitted: tally.submitted + cells.length,
    refused: tally.refused + cells.length,
    refusals: sorted(refusals),
  };
}
