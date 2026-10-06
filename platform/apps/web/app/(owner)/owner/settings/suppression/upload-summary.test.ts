import { describe, expect, it } from "vitest";
import {
  EMPTY_TALLY,
  REFUSAL_EXAMPLES,
  UPLOAD_CHUNK,
  addLocalRefusals,
  groupFailures,
  mergeChunk,
  summariseChunk,
  type DncAddEntriesResponse,
} from "./upload-summary";

/**
 * The arithmetic behind "188 numbers were refused and are not on this list".
 *
 * Every assertion here is about a way that sentence could be a lie while
 * looking right on screen: a reason that swallows the ones beside it, a row
 * number from the second batch pointing at the first batch's line, a list size
 * that multiplied itself by the number of batches.
 */

const answer = (over: Partial<DncAddEntriesResponse> = {}): DncAddEntriesResponse => ({
  accepted: 0,
  inserted: 0,
  alreadyPresent: 0,
  duplicatesInSheet: 0,
  blank: 0,
  entryCount: 0,
  failed: [],
  ...over,
});

describe("groupFailures", () => {
  it("counts every refusal, commonest reason first", () => {
    const groups = groupFailures([
      { index: 0, value: "1234567", error: "too short to be a phone number." },
      { index: 1, value: "hello", error: "that is not a phone number." },
      { index: 2, value: "12", error: "too short to be a phone number." },
    ]);
    expect(groups.map((g) => [g.reason, g.count])).toEqual([
      ["too short to be a phone number.", 2],
      ["that is not a phone number.", 1],
    ]);
  });

  it("quotes a few cells per reason but counts all of them", () => {
    const failed = Array.from({ length: 40 }, (_, i) => ({
      index: i,
      value: `bad-${i}`,
      error: "that is not a phone number.",
    }));
    const [group] = groupFailures(failed);
    // THE POINT: a sheet whose phone column is one off refuses every row, and a
    // report that quoted all of them would just be the sheet again.
    expect(group.count).toBe(40);
    expect(group.examples).toHaveLength(REFUSAL_EXAMPLES);
  });

  it("never files a refusal under a blank heading", () => {
    const [group] = groupFailures([{ index: 0, value: "x", error: "   " }]);
    expect(group.reason.length).toBeGreaterThan(0);
  });
});

describe("mergeChunk", () => {
  it("reports a later batch's refusal at its place in the SHEET, not in the batch", () => {
    // The whole reason this module exists. `index` is into the chunk that was
    // posted; the second chunk's index 0 is the sheet's row 5001.
    const chunk = summariseChunk(
      answer({ entryCount: 9_000, failed: [{ index: 0, value: "nope", error: "not a number." }] }),
    );
    const offset = UPLOAD_CHUNK;
    const tally = mergeChunk(EMPTY_TALLY, chunk, 1, (i) => `row ${offset + i + 1}`);
    expect(tally.refusals[0]?.examples).toEqual([
      { where: `row ${UPLOAD_CHUNK + 1}`, value: "nope" },
    ]);
  });

  it("takes the list's size from the last batch rather than adding them up", () => {
    // `entry_count` is recomputed with count(*) inside each insert's own
    // transaction, so summing it would multiply the list by the batch count.
    const first = summariseChunk(answer({ inserted: 5, entryCount: 5 }));
    const second = summariseChunk(answer({ inserted: 4, entryCount: 9 }));
    const where = (i: number) => `row ${i}`;
    const tally = mergeChunk(mergeChunk(EMPTY_TALLY, first, 5, where), second, 4, where);
    expect([tally.entryCount, tally.inserted, tally.submitted]).toEqual([9, 9, 9]);
  });

  it("adds a reason seen in two batches together", () => {
    const one = summariseChunk(
      answer({ failed: [{ index: 0, value: "a", error: "not a number." }] }),
    );
    const two = summariseChunk(
      answer({ failed: [{ index: 1, value: "b", error: "not a number." }] }),
    );
    const where = (i: number) => `row ${i}`;
    const tally = mergeChunk(mergeChunk(EMPTY_TALLY, one, 1, where), two, 1, where);
    expect(tally.refusals).toHaveLength(1);
    expect([tally.refusals[0]?.count, tally.refused]).toEqual([2, 2]);
  });

  it("leaves the tally it was given alone", () => {
    const before = mergeChunk(
      EMPTY_TALLY,
      summariseChunk(answer({ failed: [{ index: 0, value: "a", error: "not a number." }] })),
      1,
      (i) => `row ${i}`,
    );
    mergeChunk(
      before,
      summariseChunk(answer({ failed: [{ index: 0, value: "b", error: "not a number." }] })),
      1,
      (i) => `row ${i}`,
    );
    expect(before.refusals[0]?.count).toBe(1);
  });
});

describe("addLocalRefusals", () => {
  it("counts a cell this console removed as submitted and refused", () => {
    // A cell over the route's 40-character limit is taken out before posting,
    // because one of them 400s the whole batch. It is still a number that is
    // not on the list, so it is reported exactly like the API's own refusals.
    const tally = addLocalRefusals(EMPTY_TALLY, "too long.", [
      { where: "row 3", value: "a very long cell" },
    ]);
    expect([tally.submitted, tally.refused, tally.refusals[0]?.count]).toEqual([1, 1, 1]);
  });

  it("does nothing when there were none", () => {
    expect(addLocalRefusals(EMPTY_TALLY, "too long.", [])).toBe(EMPTY_TALLY);
  });
});
