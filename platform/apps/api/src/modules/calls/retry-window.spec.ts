import { z } from "zod";
import {
  buildRetrySummarySql,
  FAILURE_STATUSES,
  MAX_WINDOW_DAYS,
  REPROCESSABLE_STATUSES,
  describeRetryWindow,
  refineRetryWindow,
  retryWindowSql,
  toRetryWindow,
  RetryWindowInput,
} from "./retry-window";

/**
 * The window a bulk reprocess covers.
 *
 * Worth its own spec for one reason: the console shows a COUNT from
 * `GET /calls/retry-summary` and then spends money with
 * `POST /calls/reprocess-backlog`, and those two numbers have to be the same
 * set of calls. Everything below is either that promise or an input that must
 * not be allowed to reach it.
 */

const Schema = z.object(RetryWindowInput).superRefine(refineRetryWindow);
const parse = (input: Record<string, unknown>) => Schema.safeParse(input);

describe("toRetryWindow", () => {
  it("treats an absent window and an explicit null as the same thing: everything", () => {
    // Not a new default - this is the contract the transcription toggle has
    // been relying on since the backlog action existed.
    expect(toRetryWindow({})).toEqual({ kind: "all" });
    expect(toRetryWindow({ sinceDays: null })).toEqual({ kind: "all" });
  });

  it("reads a day count as a rolling window", () => {
    expect(toRetryWindow({ sinceDays: 21 })).toEqual({ kind: "days", days: 21 });
  });

  it("reads a from/to pair as a calendar range", () => {
    expect(toRetryWindow({ from: "2026-09-18", to: "2026-09-27" })).toEqual({
      kind: "range",
      from: "2026-09-18",
      to: "2026-09-27",
    });
  });
});

describe("the window as SQL", () => {
  it("matches every call when the window is everything", () => {
    // `TRUE` rather than an omitted clause, so the caller can always interpolate
    // it into an AND chain without knowing which kind it got.
    expect(retryWindowSql({ kind: "all" }, 3)).toEqual({ sql: "TRUE", params: [] });
  });

  it("numbers its placeholders from where the caller says, not from $1", () => {
    // The backlog action binds org and statuses first, so a fragment that
    // assumed it was first would silently read the status array as a day count.
    const win = retryWindowSql({ kind: "days", days: 7 }, 3);
    expect(win.sql).toBe("started_at >= now() - make_interval(days => $3)");
    expect(win.params).toEqual([7]);

    const later = retryWindowSql({ kind: "days", days: 7 }, 9);
    expect(later.sql).toContain("$9");
  });

  it("spends a calendar range over two consecutive placeholders, in order", () => {
    const win = retryWindowSql({ kind: "range", from: "2026-09-18", to: "2026-09-27" }, 3);
    expect(win.params).toEqual(["2026-09-18", "2026-09-27"]);
    expect(win.sql).toContain("$3::date");
    expect(win.sql).toContain("$4::date");
  });

  it("includes the whole of the last day, and resolves days in the org's zone", () => {
    // The upper edge is `to + 1`, EXCLUSIVE: a call that started at 23:50 on the
    // last day is in the range the operator typed. And both edges convert
    // through org_reporting_tz(), because a UTC midnight is 05:30 on an Indian
    // floor - it would take the previous evening and miss the final one.
    const { sql } = retryWindowSql({ kind: "range", from: "2026-09-01", to: "2026-09-30" }, 1);
    expect(sql).toContain("$2::date + 1");
    expect(sql).toContain("started_at <");
    expect(sql.match(/org_reporting_tz\(\)/g)).toHaveLength(2);
  });

  it("gives both routes the identical predicate for the same window", () => {
    // The whole point of the module. If this ever fails, the console is showing
    // one number and charging for another.
    const window = { kind: "range", from: "2026-09-18", to: "2026-09-27" } as const;
    const summary = retryWindowSql(window, 3);
    const action = retryWindowSql(window, 3);
    expect(summary).toEqual(action);
  });
});

describe("the assembled summary query", () => {
  /**
   * THIS IS THE PART POSTGRES CANNOT CHECK FOR US.
   *
   * Every bind is positional. A fragment that numbered itself one too low would
   * read the status array as a day count, which Postgres may well accept and
   * which produces a perfectly plausible number for the WRONG window - and
   * Docker is off on the development machine here, so nothing else in this
   * repository would notice.
   */
  const presets: Array<number | null> = [7, 21, 30, null];

  it("binds every parameter exactly once, in placeholder order", () => {
    const built = buildRetrySummarySql(presets, { kind: "range", from: "2026-09-18", to: "2026-09-27" });
    // $1 org, $2 statuses, then 7/21/30 (one each), "all" (none), then the range
    // (two). The order below IS the order node-postgres will read them in.
    expect(built.params).toEqual([7, 21, 30, "2026-09-18", "2026-09-27"]);

    // Every placeholder from $1 up to the highest appears, with no gaps and
    // nothing beyond the parameters actually supplied.
    const used = [...built.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const highest = Math.max(...used);
    expect(highest).toBe(built.params.length + 2);
    for (let n = 1; n <= highest; n++) expect(used).toContain(n);
  });

  it("keeps $1 and $2 for the org and the status list", () => {
    const built = buildRetrySummarySql(presets, { kind: "days", days: 30 });
    expect(built.sql).toContain("org_id = $1");
    expect(built.sql).toContain("status = ANY($2::text[])");
    // The first window therefore starts at $3, not $1.
    expect(built.sql).toContain("make_interval(days => $3)");
  });

  it("counts every preset and the selected window separately", () => {
    const built = buildRetrySummarySql(presets, { kind: "days", days: 14 });
    for (let i = 0; i < presets.length; i++) {
      expect(built.sql).toContain(`AS p${i}_calls`);
      expect(built.sql).toContain(`AS p${i}_seconds`);
    }
    // Counted again rather than reusing a preset column, even when the selected
    // window equals one: the response reports them separately, and a shared
    // column would make the two disagree the moment one changed.
    expect(built.sql).toContain("AS sel_calls");
    expect(built.params).toEqual([7, 21, 30, 14]);
  });

  it("does not spend a parameter on the everything window", () => {
    // `TRUE` takes no bind. If it ever did, every later placeholder would shift.
    const built = buildRetrySummarySql([null], { kind: "all" });
    expect(built.params).toEqual([]);
    expect(built.sql).not.toMatch(/\$[3-9]/);
  });

  it("reads oldest and newest through the SELECTED window, not all of history", () => {
    // The panel prints these as "oldest failure", beside a count that is scoped.
    // An unscoped min() would name a call the operator is not about to touch.
    const built = buildRetrySummarySql(presets, { kind: "days", days: 7 });
    expect(built.sql).toContain(`min(started_at) FILTER (WHERE ${built.selectedSql}) AS oldest`);
    expect(built.sql).toContain(`max(started_at) FILTER (WHERE ${built.selectedSql}) AS newest`);
  });

  it("groups by status, so the console can list what failed", () => {
    const built = buildRetrySummarySql(presets, { kind: "all" });
    expect(built.sql).toContain("GROUP BY status");
  });
});

describe("what the input refuses", () => {
  it("accepts a bare day count and a bare range", () => {
    expect(parse({ sinceDays: 30 }).success).toBe(true);
    expect(parse({ from: "2026-09-01", to: "2026-09-30" }).success).toBe(true);
    expect(parse({}).success).toBe(true);
  });

  it("refuses half a range", () => {
    expect(parse({ from: "2026-09-01" }).success).toBe(false);
    expect(parse({ to: "2026-09-30" }).success).toBe(false);
  });

  it("refuses a reversed range rather than swapping it", () => {
    // A bulk spend is the wrong place to guess what somebody meant.
    const res = parse({ from: "2026-09-30", to: "2026-09-01" });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain("from must not be after to");
  });

  it("refuses a day count AND a range in one request", () => {
    // Two windows is not a window. Silently preferring one would make the
    // console's summary disagree with what the action did.
    const res = parse({ sinceDays: 7, from: "2026-09-01", to: "2026-09-30" });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain("not both");
  });

  it("refuses a date that is not a real day", () => {
    // 2026 is not a leap year. A string-shaped date check would pass this.
    expect(parse({ from: "2026-02-29", to: "2026-03-01" }).success).toBe(false);
  });

  it("refuses a span longer than the cap, either way it is spelt", () => {
    expect(parse({ sinceDays: MAX_WINDOW_DAYS + 1 }).success).toBe(false);
    expect(parse({ from: "2000-01-01", to: "2026-01-01" }).success).toBe(false);
  });

  it("refuses a zero or negative day count", () => {
    expect(parse({ sinceDays: 0 }).success).toBe(false);
    expect(parse({ sinceDays: -7 }).success).toBe(false);
  });
});

describe("the status lists", () => {
  it("keeps FAILED_UPLOAD and NO_AUDIO out of everything reprocessable", () => {
    // Both are terminal with nothing to retry: no audio ever reached S3 (0101),
    // or the call was never answered (0133). Rewinding either only fails again.
    expect(REPROCESSABLE_STATUSES).not.toContain("FAILED_UPLOAD");
    expect(REPROCESSABLE_STATUSES).not.toContain("NO_AUDIO");
  });

  it("counts only genuine failures as failures", () => {
    // COMPLETE and TRANSCRIPTION_OFF can be rewound but did not FAIL. If they
    // leaked into this list, a panel labelled "retry what broke" would open with
    // the tenant's entire history as its headline number.
    expect([...FAILURE_STATUSES]).toEqual([
      "FAILED_TRANSCODE",
      "FAILED_ASR",
      "FAILED_ANALYZE",
      "FAILED_CRM",
    ]);
    for (const status of FAILURE_STATUSES) {
      expect(REPROCESSABLE_STATUSES).toContain(status);
    }
  });
});

describe("describeRetryWindow", () => {
  it("says what was covered, for the audit row and the confirmation", () => {
    expect(describeRetryWindow({ kind: "all" })).toBe("every stored call");
    expect(describeRetryWindow({ kind: "days", days: 21 })).toBe("the last 21 days");
    expect(describeRetryWindow({ kind: "days", days: 1 })).toBe("the last 1 day");
    expect(describeRetryWindow({ kind: "range", from: "2026-09-18", to: "2026-09-27" })).toBe(
      "2026-09-18 to 2026-09-27",
    );
  });
});
