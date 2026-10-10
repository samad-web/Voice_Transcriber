import { describe, expect, it } from "vitest";

import { CLOSE_CHECKLIST, complianceStatus } from "./compliance";
import { advisorRule } from "./finance-advisor";
import {
  decideBooksNotClosed,
  decideComplianceDue,
  decideComplianceOverdue,
  decideDocumentExpired,
  decideDocumentExpiring,
} from "./finance-detectors";

/**
 * The five reminder rules from
 * Build docs/indian-business-finance-documents-cycles-import §2, held to the
 * same standard §14 M8 sets for the seventeen: "a fixture test that fires it
 * and a test that does not."
 *
 * Plus one kind of test the seventeen do not need. These five overlap by
 * construction - `compliance_due` and `compliance_overdue` read the same
 * filing on consecutive days, and `document_expiring` and `document_expired`
 * the same document - so each has a test that it stays quiet on the state its
 * neighbour owns. Two rules firing on one row is how an inbox doubles
 * overnight and stops being read.
 */

const NO_PARAMS: Record<string, number> = {};

describe("compliance_due", () => {
  // Due on the 20th, reminding 7, 3 and 1 days out: the 13th, 17th and 19th.
  const filing = {
    filingId: "f1",
    itemCode: "gstr3b_monthly",
    name: "GSTR-3B (summary return and payment)",
    periodLabel: "February 2026",
    dueOn: "2026-03-20",
    filedOn: null,
    waivedAt: null,
    reminderOffsets: [7, 3, 1],
  };

  it("fires on a reminder day, naming the filing, its period and the date", () => {
    const verdict = decideComplianceDue(filing, "2026-03-17", NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.message).toContain("GSTR-3B");
    expect(verdict.message).toContain("February 2026");
    expect(verdict.message).toContain("2026-03-20");
    expect(verdict.explain.records).toEqual([
      { type: "compliance_filing", id: "f1", label: "GSTR-3B (summary return and payment)" },
    ]);
    expect(verdict.amountAtRiskMinor).toBeNull();
  });

  it("fires on each of the three reminder days and no others", () => {
    const fires = ["2026-03-13", "2026-03-17", "2026-03-19"];
    const quiet = ["2026-03-12", "2026-03-14", "2026-03-18", "2026-03-20"];
    for (const day of fires) expect(decideComplianceDue(filing, day, NO_PARAMS).fire).toBe(true);
    for (const day of quiet) expect(decideComplianceDue(filing, day, NO_PARAMS).fire).toBe(false);
  });

  it("stays quiet on a day between the reminders, and says why", () => {
    const verdict = decideComplianceDue(filing, "2026-03-18", NO_PARAMS);
    expect(verdict.fire).toBe(false);
    expect(verdict.silentBecause).toMatch(/not one of its reminder days/);
  });

  it("stays quiet once filed, and once waived", () => {
    expect(decideComplianceDue({ ...filing, filedOn: "2026-03-16" }, "2026-03-17", NO_PARAMS).silentBecause).toMatch(
      /already been filed/,
    );
    expect(decideComplianceDue({ ...filing, waivedAt: "2026-03-01" }, "2026-03-17", NO_PARAMS).silentBecause).toMatch(
      /not applicable/,
    );
  });

  it("hands an overdue filing to the overdue rule rather than firing as well", () => {
    const verdict = decideComplianceDue(filing, "2026-03-25", NO_PARAMS);
    expect(verdict.fire).toBe(false);
    expect(verdict.silentBecause).toMatch(/overdue rule reports instead/);
  });

  it("falls back to the rule's own window for an item whose offsets were cleared", () => {
    const bare = { ...filing, reminderOffsets: [] };
    expect(advisorRule("compliance_due").params.fallbackDays).toBe(7);
    expect(decideComplianceDue(bare, "2026-03-13", NO_PARAMS).fire).toBe(true);
    expect(decideComplianceDue(bare, "2026-03-17", NO_PARAMS).fire).toBe(false);
  });

  it("honours an owner's tuned fallback", () => {
    const bare = { ...filing, reminderOffsets: [] };
    expect(decideComplianceDue(bare, "2026-03-10", { fallbackDays: 10 }).fire).toBe(true);
  });
});

describe("compliance_overdue", () => {
  const filing = {
    filingId: "f1",
    itemCode: "tds_deposit",
    name: "TDS / TCS deposit",
    periodLabel: "February 2026",
    dueOn: "2026-03-07",
    filedOn: null,
    waivedAt: null,
    reminderOffsets: [5, 2],
  };

  it("fires the day after the due date and says how late it is", () => {
    const verdict = decideComplianceOverdue(filing, "2026-03-08", NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.message).toContain("1 days overdue");
    expect(verdict.explain.inputs.lateBy).toBe(1);
  });

  it("does not fire on the due date itself", () => {
    // The same boundary as `scheduleItemStatus`: due today is not late today.
    expect(decideComplianceOverdue(filing, "2026-03-07", NO_PARAMS).fire).toBe(false);
  });

  it("re-raises weekly rather than nightly, so one filing is not thirty alerts", () => {
    expect(decideComplianceOverdue(filing, "2026-03-14", NO_PARAMS).fire).toBe(true);
    expect(decideComplianceOverdue(filing, "2026-03-15", NO_PARAMS).fire).toBe(false);
    expect(decideComplianceOverdue(filing, "2026-03-21", NO_PARAMS).fire).toBe(true);
  });

  it("stays quiet once filed or waived, however late", () => {
    expect(decideComplianceOverdue({ ...filing, filedOn: "2026-04-01" }, "2026-05-01", NO_PARAMS).fire).toBe(false);
    expect(decideComplianceOverdue({ ...filing, waivedAt: "2026-04-01" }, "2026-05-01", NO_PARAMS).fire).toBe(false);
  });

  it("stays quiet on a filing that is merely approaching, which the due rule owns", () => {
    expect(decideComplianceOverdue({ ...filing, dueOn: "2026-03-20" }, "2026-03-17", NO_PARAMS).fire).toBe(false);
  });

  it("takes a tuned repeat cadence", () => {
    expect(decideComplianceOverdue(filing, "2026-03-09", { repeatEveryDays: 2 }).fire).toBe(true);
    expect(decideComplianceOverdue(filing, "2026-03-10", { repeatEveryDays: 2 }).fire).toBe(false);
  });
});

describe("document_expiring", () => {
  const licence = {
    documentId: "d1",
    title: "Shops and Establishment licence",
    categoryCode: "shops_establishment",
    expiresOn: "2026-05-14",
    reminderOffsets: [60, 30, 7],
    superseded: false,
  };

  it("fires 60 days out, this category's furthest reminder", () => {
    const verdict = decideDocumentExpiring(licence, "2026-03-15", NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.message).toContain("Shops and Establishment licence");
    expect(verdict.message).toContain("60 days away");
    expect(verdict.explain.records[0]).toMatchObject({ type: "business_document", id: "d1" });
  });

  it("fires on each offset and stays quiet between them", () => {
    expect(decideDocumentExpiring(licence, "2026-04-14", NO_PARAMS).fire).toBe(true);
    expect(decideDocumentExpiring(licence, "2026-05-07", NO_PARAMS).fire).toBe(true);
    expect(decideDocumentExpiring(licence, "2026-03-16", NO_PARAMS).fire).toBe(false);
    expect(decideDocumentExpiring(licence, "2026-05-01", NO_PARAMS).fire).toBe(false);
  });

  it("stays quiet once a newer version is uploaded", () => {
    expect(decideDocumentExpiring({ ...licence, superseded: true }, "2026-03-15", NO_PARAMS).silentBecause).toMatch(
      /newer version/,
    );
  });

  it("stays quiet for a document with no expiry at all", () => {
    expect(decideDocumentExpiring({ ...licence, expiresOn: null }, "2026-03-15", NO_PARAMS).silentBecause).toMatch(
      /no expiry date/,
    );
  });

  it("stays quiet on an already-expired document, which the expired rule owns", () => {
    expect(decideDocumentExpiring({ ...licence, expiresOn: "2026-03-01" }, "2026-03-15", NO_PARAMS).fire).toBe(false);
  });
});

describe("document_expired", () => {
  const policy = {
    documentId: "d2",
    title: "Office insurance policy",
    categoryCode: "insurance_policy",
    expiresOn: "2026-03-14",
    reminderOffsets: [60, 30, 7],
    superseded: false,
  };

  it("fires the day after expiry", () => {
    const verdict = decideDocumentExpired(policy, "2026-03-15", NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.message).toContain("expired on 2026-03-14");
    expect(verdict.message).toContain("1 days ago");
  });

  it("does not fire on the expiry date, which the document is still valid through", () => {
    expect(decideDocumentExpired(policy, "2026-03-14", NO_PARAMS).fire).toBe(false);
  });

  it("stays quiet on a document that has not expired, which the expiring rule owns", () => {
    expect(decideDocumentExpired({ ...policy, expiresOn: "2026-05-14" }, "2026-03-15", NO_PARAMS).fire).toBe(false);
  });

  it("re-raises fortnightly", () => {
    expect(decideDocumentExpired(policy, "2026-03-28", NO_PARAMS).fire).toBe(true);
    expect(decideDocumentExpired(policy, "2026-03-29", NO_PARAMS).fire).toBe(false);
  });

  it("stops the moment a renewal is uploaded", () => {
    expect(decideDocumentExpired({ ...policy, superseded: true }, "2026-03-15", NO_PARAMS).fire).toBe(false);
  });
});

describe("books_not_closed", () => {
  const february = {
    month: "2026-02-01",
    periodLabel: "February 2026",
    monthEnd: "2026-02-28",
    doneStepKeys: ["payments_matched"],
    lockedAt: null,
  };

  it("fires once the grace period has passed with the checklist incomplete", () => {
    // Grace is 10 days from 28 February, so 10 March.
    const verdict = decideBooksNotClosed(february, "2026-03-10", NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.message).toContain("February 2026");
    expect(verdict.message).toContain(`1 of ${CLOSE_CHECKLIST.length}`);
    expect(verdict.explain.inputs.blocking).toContain("bank_reconciled");
  });

  it("stays quiet during the grace period, because the work is not yet due", () => {
    const verdict = decideBooksNotClosed(february, "2026-03-05", NO_PARAMS);
    expect(verdict.fire).toBe(false);
    expect(verdict.silentBecause).toMatch(/grace period/);
  });

  it("stays quiet once the period is locked", () => {
    expect(
      decideBooksNotClosed({ ...february, lockedAt: "2026-03-02T00:00:00Z" }, "2026-03-20", NO_PARAMS).silentBecause,
    ).toMatch(/locked/);
  });

  it("stays quiet when every step is done and only the lock is left", () => {
    const done = { ...february, doneStepKeys: CLOSE_CHECKLIST.map((s) => s.key) };
    expect(decideBooksNotClosed(done, "2026-03-20", NO_PARAMS).silentBecause).toMatch(/only the lock is left/);
  });

  it("re-raises weekly after the first alert", () => {
    expect(decideBooksNotClosed(february, "2026-03-17", NO_PARAMS).fire).toBe(true);
    expect(decideBooksNotClosed(february, "2026-03-18", NO_PARAMS).fire).toBe(false);
  });

  it("takes a tuned grace period", () => {
    expect(decideBooksNotClosed(february, "2026-03-01", { graceDays: 1 }).fire).toBe(true);
  });
});

/**
 * The back-fill guard, added after a real mid-year seed produced thirty-one
 * overdue filings and would have raised thirty-one critical alerts on day one.
 */
describe("compliance_overdue - a back-filled period is not a missed deadline", () => {
  const filing = {
    filingId: "f9",
    itemCode: "gstr3b_monthly",
    name: "GSTR-3B (summary return and payment)",
    periodLabel: "April 2026",
    dueOn: "2026-05-20",
    filedOn: null,
    waivedAt: null,
    reminderOffsets: [7, 3, 1],
  };

  it("stays silent when the row was generated after it was already due", () => {
    // Seeded in October for a year that opened in April.
    const verdict = decideComplianceOverdue(
      { ...filing, generatedOn: "2026-10-10" },
      "2026-10-11",
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(false);
    expect(verdict.silentBecause).toMatch(/already past its due date when the calendar was set up/);
  });

  it("still fires for a period the calendar was watching when it came due", () => {
    const verdict = decideComplianceOverdue(
      { ...filing, generatedOn: "2026-04-01" },
      "2026-05-21",
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(true);
  });

  it("fires on the generation date itself, which is not after the due date", () => {
    expect(
      decideComplianceOverdue({ ...filing, generatedOn: "2026-05-20" }, "2026-05-21", NO_PARAMS).fire,
    ).toBe(true);
  });

  it("behaves as before when the caller does not supply the date", () => {
    expect(decideComplianceOverdue(filing, "2026-05-21", NO_PARAMS).fire).toBe(true);
    expect(decideComplianceOverdue({ ...filing, generatedOn: null }, "2026-05-21", NO_PARAMS).fire).toBe(
      true,
    );
  });

  it("leaves the filing visibly overdue on the calendar - only the ALERT is suppressed", () => {
    // The status is what the page colours, and it is unchanged. The record is
    // real; what is not real is the claim the business missed it.
    expect(complianceStatus({ ...filing }, "2026-10-11")).toBe("overdue");
  });
});
