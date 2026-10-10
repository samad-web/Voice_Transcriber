import { describe, expect, it } from "vitest";

import {
  classifyCell,
  columnKindShare,
  dedupeHeaders,
  describeDryRun,
  detectDateOrder,
  detectHeaderRow,
  detectKind,
  detectSource,
  dominantKind,
  dryRunIsEmpty,
  findDuplicatesInFile,
  IMPORTABLE_KINDS,
  isBlankRow,
  isTotalRow,
  parseAmountCell,
  parseDateCell,
  rowFingerprint,
  splitGrid,
  UNSUPPORTED_KIND_MESSAGE,
} from "./import-detect";

describe("blank and total rows", () => {
  it("sees a row of empties and whitespace as blank", () => {
    expect(isBlankRow(["", "  ", null])).toBe(true);
    expect(isBlankRow(["", "x"])).toBe(false);
  });

  it("drops a total row", () => {
    expect(isTotalRow(["Total", "", "4,52,000"])).toBe(true);
    expect(isTotalRow(["", "", "Grand Total", "1,00,000"])).toBe(true);
    expect(isTotalRow(["Closing Balance", "", "12,345.00"])).toBe(true);
  });

  it("tolerates punctuation after the word", () => {
    expect(isTotalRow(["Total:", "", "100"])).toBe(true);
    expect(isTotalRow(["TOTAL -", "", "100"])).toBe(true);
  });

  it("never eats a customer whose NAME contains the word", () => {
    // The anchored match exists for this: substring matching would delete
    // every one of these rows.
    expect(isTotalRow(["Grand Total Traders", "9876543210", "ashok@x.com", "50,000"])).toBe(false);
    expect(isTotalRow(["Subtotal Systems Pvt Ltd", "27AAAAA0000A1Z5", "Mumbai", "1,000"])).toBe(false);
  });

  it("does not call a full data row a total just because one cell says Sum", () => {
    expect(isTotalRow(["Sum", "2026-09-17", "1000", "UTR123", "Ashok", "paid", "x"])).toBe(false);
  });

  it("is false for a row with no cells at all", () => {
    expect(isTotalRow(["", "", ""])).toBe(false);
  });
});

describe("detectHeaderRow", () => {
  it("takes the first row when it is the header", () => {
    const grid = [
      ["Customer", "Amount", "Date"],
      ["Ashok", "1000", "17/09/2026"],
    ];
    expect(detectHeaderRow(grid)).toMatchObject({ index: 0 });
    expect(detectHeaderRow(grid).confidence).toBeGreaterThan(0.5);
  });

  it("skips a bank statement's title block", () => {
    // The shape §3 names: a title, an account line, a date range, a blank.
    const grid = [
      ["HDFC BANK LTD", "", "", ""],
      ["Account No: 50100123456789", "", "", ""],
      ["Statement from 01/09/2026 to 30/09/2026", "", "", ""],
      ["", "", "", ""],
      ["Date", "Narration", "Withdrawal Amt.", "Closing Balance"],
      ["01/09/2026", "UPI-ASHOK", "", "1,02,500.00"],
    ];
    const found = detectHeaderRow(grid);
    expect(found.index).toBe(4);
    expect(found.reason).toMatch(/title block/);
  });

  it("ignores a merged title cell, which reads as one filled cell in a blank row", () => {
    const grid = [
      ["Monthly Expense Register", "", "", ""],
      ["Date", "Vendor", "Category", "Amount"],
      ["01/09/2026", "Airtel", "Telecom", "2,360"],
    ];
    expect(detectHeaderRow(grid).index).toBe(1);
  });

  it("does not take a row of numbers as the header", () => {
    const grid = [
      ["Date", "Amount"],
      ["01/09/2026", "1000"],
      ["02/09/2026", "2000"],
    ];
    expect(detectHeaderRow(grid).index).toBe(0);
  });

  it("penalises a row of prose, which is a note rather than a header", () => {
    const grid = [
      [
        "This statement is computer generated and does not require a signature. Please verify all entries.",
        "and keep it for your records",
        "",
      ],
      ["Date", "Particulars", "Amount"],
      ["01/09/2026", "Opening", "100"],
    ];
    expect(detectHeaderRow(grid).index).toBe(1);
  });

  it("returns null rather than a guess for a file with no header at all", () => {
    expect(detectHeaderRow([]).index).toBeNull();
    expect(detectHeaderRow([["x"], ["y"]]).index).toBeNull();
  });

  it("takes the header band ADJACENT to the data when two bands stack", () => {
    // A merged header often renders as two identical bands. The lower one is
    // the real column row - it is the one the data lines up under - so the
    // "row before the numbers" signal is allowed to outweigh "earliest wins".
    // Either choice reads this file correctly; this pins which one happens.
    const grid = [
      ["Date", "Amount", "Ref"],
      ["Date", "Amount", "Ref"],
      ["01/09/2026", "100", "A1"],
    ];
    expect(detectHeaderRow(grid).index).toBe(1);
    expect(splitGrid(grid).rows).toEqual([["01/09/2026", "100", "A1"]]);
  });
});

describe("dedupeHeaders", () => {
  it("numbers a repeated header instead of letting it shadow the first", () => {
    expect(dedupeHeaders(["Amount", "Amount", "Amount"])).toEqual(["Amount", "Amount (2)", "Amount (3)"]);
  });

  it("is case-insensitive about what counts as a repeat", () => {
    expect(dedupeHeaders(["Amount", "amount"])).toEqual(["Amount", "amount (2)"]);
  });

  it("names an unnamed column so it can still be mapped or ignored", () => {
    expect(dedupeHeaders(["Date", "", "  "])).toEqual(["Date", "Column 2", "Column 3"]);
  });
});

describe("splitGrid", () => {
  const grid = [
    ["ICICI BANK", "", ""],
    ["", "", ""],
    ["Date", "Narration", "Amount"],
    ["01/09/2026", "NEFT ASHOK", "1,02,500.00"],
    ["", "", ""],
    ["02/09/2026", "UPI PRIYA", "7,500.00"],
    ["Total", "", "1,10,000.00"],
  ];

  it("finds the header, keeps the data and counts what it dropped", () => {
    const split = splitGrid(grid);
    expect(split.headers).toEqual(["Date", "Narration", "Amount"]);
    expect(split.rows).toHaveLength(2);
    expect(split.skippedBlank).toBe(1);
    expect(split.skippedTotals).toBe(1);
  });

  it("reports SOURCE row numbers, so an error points at the right line of the file", () => {
    // The data rows are lines 4 and 6 of the file, not 1 and 2 of the result.
    expect(splitGrid(grid).sourceRowNumbers).toEqual([4, 6]);
  });

  it("takes an explicit header row when a person overrides the guess", () => {
    const split = splitGrid(grid, { headerRow: 0 });
    expect(split.headers).toEqual(["ICICI BANK", "Column 2", "Column 3"]);
    expect(split.header.reason).toBe("Chosen by hand.");
  });

  it("returns nothing usable rather than throwing when there is no header", () => {
    expect(splitGrid([])).toMatchObject({ headers: [], rows: [], sourceRowNumbers: [] });
  });

  it("pads a short row to the header width", () => {
    const split = splitGrid([
      ["A", "B", "C"],
      ["1"],
    ]);
    expect(split.rows[0]).toEqual(["1", "", ""]);
  });
});

describe("classifyCell", () => {
  it("recognises the Indian identifiers §3 lists", () => {
    expect(classifyCell("27AAPFU0939F1ZV")).toBe("gstin");
    expect(classifyCell("AAPFU0939F")).toBe("pan");
    expect(classifyCell("HDFC0001234")).toBe("ifsc");
    expect(classifyCell("ashok@okhdfcbank")).toBe("upi");
  });

  it("normalises case and spacing before testing an identifier", () => {
    expect(classifyCell(" 27aapfu0939f1zv ")).toBe("gstin");
  });

  it("recognises money, dates and phone numbers", () => {
    expect(classifyCell("₹1,02,500.50")).toBe("amount");
    expect(classifyCell("(1,234.00)")).toBe("amount");
    expect(classifyCell("1,234.00 Dr")).toBe("amount");
    expect(classifyCell("17/09/2026")).toBe("date");
    expect(classifyCell("2026-09-17")).toBe("date");
    expect(classifyCell("17 Sep 2026")).toBe("date");
    expect(classifyCell("9876543210")).toBe("phone");
    expect(classifyCell("+91 98765 43210")).toBe("phone");
  });

  it("does not claim a 10-digit invoice number as a phone number", () => {
    // Indian mobiles start 6-9; 1000012345 does not.
    expect(classifyCell("1000012345")).not.toBe("phone");
  });

  it("falls back to number and text", () => {
    expect(classifyCell("42")).toBe("number");
    expect(classifyCell("Telecom")).toBe("text");
  });

  it("calls an empty cell empty", () => {
    expect([classifyCell(""), classifyCell("   "), classifyCell(null), classifyCell(undefined)]).toEqual([
      "empty",
      "empty",
      "empty",
      "empty",
    ]);
  });
});

describe("column kinds", () => {
  it("measures the share of a column that is one kind, ignoring blanks", () => {
    expect(columnKindShare(["HDFC0001234", "ICIC0000123", "", null], "ifsc")).toBe(1);
    expect(columnKindShare(["HDFC0001234", "nonsense"], "ifsc")).toBe(0.5);
  });

  it("is zero for an all-empty column rather than NaN", () => {
    expect(columnKindShare(["", null], "ifsc")).toBe(0);
  });

  it("names the dominant kind", () => {
    expect(dominantKind(["1,000", "2,000", "x"])).toEqual({ kind: "amount", share: 2 / 3 });
    expect(dominantKind([null, ""])).toEqual({ kind: "empty", share: 1 });
  });
});

describe("detectDateOrder - the most dangerous question in the import", () => {
  it("settles on day-first from a single value past the 12th", () => {
    const found = detectDateOrder(["05/09/2026", "17/09/2026", "02/10/2026"]);
    expect(found.order).toBe("dmy");
    expect(found.evidence).toContain("17/09/2026");
    expect(found.message).toMatch(/no other reading/);
  });

  it("settles on month-first from a single value past the 12th", () => {
    expect(detectDateOrder(["09/17/2026", "01/05/2026"]).order).toBe("mdy");
  });

  it("refuses to guess when every day is under the 13th", () => {
    // The correct answer is "ask", not "probably dmy because we are in India".
    const found = detectDateOrder(["05/09/2026", "01/02/2026", "03/04/2026"]);
    expect(found.order).toBe("ambiguous");
    expect(found.message).toMatch(/could be read either way/);
    expect(found.evidence.length).toBeGreaterThan(0);
  });

  it("reports a conflict when the column holds both, rather than picking the majority", () => {
    const found = detectDateOrder(["17/09/2026", "09/17/2026"]);
    expect(found.order).toBe("conflict");
    expect(found.evidence).toEqual(["17/09/2026", "09/17/2026"]);
    expect(found.message).toMatch(/mixes date formats/);
  });

  it("calls ISO and named-month columns unambiguous", () => {
    expect(detectDateOrder(["2026-09-17", "2026-10-01"]).order).toBe("iso");
    expect(detectDateOrder(["17 Sep 2026", "1 Oct 2026"]).order).toBe("iso");
    expect(detectDateOrder(["2026/09/17"]).order).toBe("iso");
  });

  it("says so when a column has no dates in it", () => {
    expect(detectDateOrder(["Ashok", "", null]).order).toBe("ambiguous");
    expect(detectDateOrder([]).message).toMatch(/No dates/);
  });

  it("ignores blanks while judging", () => {
    expect(detectDateOrder(["", "17/09/2026", null]).order).toBe("dmy");
  });
});

describe("parseDateCell", () => {
  it("reads ISO straight through", () => {
    expect(parseDateCell("2026-09-17", "iso")).toBe("2026-09-17");
  });

  it("reads the two orders as told", () => {
    expect(parseDateCell("05/09/2026", "dmy")).toBe("2026-09-05");
    expect(parseDateCell("05/09/2026", "mdy")).toBe("2026-05-09");
  });

  it("returns null for an ambiguous order rather than quietly choosing", () => {
    // The row lands in the error report instead of in the database.
    expect(parseDateCell("05/09/2026", "ambiguous")).toBeNull();
    expect(parseDateCell("05/09/2026", "conflict")).toBeNull();
  });

  it("still reads an unambiguous value under an ambiguous-but-ISO column", () => {
    expect(parseDateCell("17/09/2026", "iso")).toBe("2026-09-17");
    expect(parseDateCell("09/17/2026", "iso")).toBe("2026-09-17");
    expect(parseDateCell("05/09/2026", "iso")).toBeNull();
  });

  it("reads a named month whatever the order says", () => {
    expect(parseDateCell("17 Sep 2026", "ambiguous")).toBe("2026-09-17");
    expect(parseDateCell("17-Sep-26", "ambiguous")).toBe("2026-09-17");
    expect(parseDateCell("Sep 17, 2026", "ambiguous")).toBe("2026-09-17");
    expect(parseDateCell("17 September 2026", "mdy")).toBe("2026-09-17");
  });

  it("reads yyyy/mm/dd whatever the order says", () => {
    expect(parseDateCell("2026/09/17", "mdy")).toBe("2026-09-17");
  });

  it("windows a two-digit year the way every spreadsheet does", () => {
    expect(parseDateCell("17/09/26", "dmy")).toBe("2026-09-17");
    expect(parseDateCell("17/09/98", "dmy")).toBe("1998-09-17");
    expect(parseDateCell("17/09/69", "dmy")).toBe("2069-09-17");
    expect(parseDateCell("17/09/70", "dmy")).toBe("1970-09-17");
  });

  it("rejects a date that does not exist", () => {
    expect(parseDateCell("30/02/2026", "dmy")).toBeNull();
    expect(parseDateCell("31/13/2026", "dmy")).toBeNull();
  });

  it("rejects an unparseable cell and a blank one", () => {
    expect([parseDateCell("later", "dmy"), parseDateCell("", "dmy"), parseDateCell(null, "dmy")]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("accepts dot and dash separators", () => {
    expect(parseDateCell("17.09.2026", "dmy")).toBe("2026-09-17");
    expect(parseDateCell("17-09-2026", "dmy")).toBe("2026-09-17");
  });
});

describe("parseAmountCell", () => {
  it("reads Indian grouping, which Number() rejects outright", () => {
    expect(parseAmountCell("1,02,500.50")?.minor).toBe(10250050);
  });

  it("reads Western grouping and a currency symbol", () => {
    expect(parseAmountCell("102,500.50")?.minor).toBe(10250050);
    expect(parseAmountCell("₹ 1,02,500")?.minor).toBe(10250000);
    expect(parseAmountCell("$1,234.00")?.minor).toBe(123400);
  });

  it("reads brackets as negative, the way accountants write it", () => {
    expect(parseAmountCell("(1,234.00)")).toMatchObject({ minor: -123400, negativeBecause: "brackets" });
  });

  it("reads a leading minus", () => {
    expect(parseAmountCell("-1,234.00")).toMatchObject({ minor: -123400, negativeBecause: "sign" });
  });

  it("reads a Dr marker as negative and keeps Cr positive", () => {
    expect(parseAmountCell("1,234.00 Dr")).toMatchObject({
      minor: -123400,
      marker: "dr",
      negativeBecause: "debit_marker",
    });
    expect(parseAmountCell("1,234.00 Cr")).toMatchObject({ minor: 123400, marker: "cr", negativeBecause: null });
  });

  it("reads a leading marker too", () => {
    expect(parseAmountCell("Dr 500")?.minor).toBe(-50000);
    expect(parseAmountCell("Cr 500")?.minor).toBe(50000);
  });

  it("reads European grouping, which some gateways send", () => {
    expect(parseAmountCell("1.234,56")?.minor).toBe(123456);
    expect(parseAmountCell("1.234.567,89")?.minor).toBe(123456789);
  });

  it("refuses a dotted string that is not a format anybody writes", () => {
    // "1.02.500" is neither Indian (which groups with commas) nor European
    // (which groups in threes). Guessing at it would be inventing a number.
    expect(parseAmountCell("1.02.500")).toBeNull();
  });

  it("treats a dash as nil rather than as zero or an error", () => {
    // Tally prints a dash for nothing. Null keeps "not stated" distinct from
    // "stated as zero", which matters for a required-field check.
    expect([parseAmountCell("-"), parseAmountCell("–"), parseAmountCell("")]).toEqual([null, null, null]);
  });

  it("reads a plain zero as zero, not as nil", () => {
    expect(parseAmountCell("0")?.minor).toBe(0);
    expect(parseAmountCell("0.00")?.minor).toBe(0);
  });

  it("does not multiply through a float, so paise survive", () => {
    // 1,02,500.55 through a double is 10250054.999999998.
    expect(parseAmountCell("1,02,500.55")?.minor).toBe(10250055);
    expect(parseAmountCell("0.07")?.minor).toBe(7);
  });

  it("rejects text and a number with stray letters", () => {
    expect([parseAmountCell("about five"), parseAmountCell("12ab"), parseAmountCell("N/A")]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("strips a non-breaking space, which is what a pasted web table carries", () => {
    expect(parseAmountCell("1,234.00 ")?.minor).toBe(123400);
  });
});

describe("detectKind", () => {
  it("recognises a payment file", () => {
    const found = detectKind(["Payment Date", "Amount", "Mode", "UTR", "Customer"]);
    expect(found.kind).toBe("payment");
    expect(found.importable).toBe(true);
    expect(found.matchedHeaders.length).toBeGreaterThan(0);
  });

  it("recognises a bank statement", () => {
    expect(detectKind(["Date", "Narration", "Chq./Ref.No.", "Withdrawal Amt.", "Closing Balance"]).kind).toBe(
      "bank_txn",
    );
  });

  it("recognises an expense register", () => {
    expect(detectKind(["Date", "Vendor", "Category", "Amount", "Bill No", "GST"]).kind).toBe("expense");
  });

  it("recognises a contact list", () => {
    expect(detectKind(["Full Name", "Mobile", "Email", "Designation"]).kind).toBe("contact");
  });

  it("recognises a call log and says it cannot be imported", () => {
    const found = detectKind(["Call Date", "Call Duration", "Disposition", "Recording"]);
    expect(found.kind).toBe("call_log");
    expect(found.importable).toBe(false);
    expect(found.message).toMatch(/arrive from the handset app/);
  });

  it("recognises a payroll sheet and says where people are added instead", () => {
    const found = detectKind(["Employee Code", "Employee Name", "Basic", "Gross Pay", "UAN", "DOJ"]);
    expect(found.kind).toBe("employee");
    expect(found.importable).toBe(false);
    expect(found.message).toMatch(/organization chart/);
  });

  it("recognises a ledger and an invoice list", () => {
    expect(detectKind(["Voucher Type", "Account Head", "Debit", "Credit"]).kind).toBe("ledger");
    expect(detectKind(["Invoice Number", "Bill To", "Taxable Value", "HSN", "IRN"]).kind).toBe("invoice");
  });

  it("gives every unsupported kind a message that says what to do instead", () => {
    for (const [kind, message] of Object.entries(UNSUPPORTED_KIND_MESSAGE)) {
      expect(IMPORTABLE_KINDS).not.toContain(kind);
      expect(message.length).toBeGreaterThan(20);
    }
  });

  it("says unknown rather than guessing at an unrecognisable file", () => {
    const found = detectKind(["Col1", "Col2", "Col3"]);
    expect(found.kind).toBe("unknown");
    expect(found.confidence).toBe(0);
    expect(found.message).toMatch(/do not match anything recognisable/);
  });

  it("uses content only to break a tie, never to outvote a header", () => {
    // Headers say contact; a column of GSTINs should not flip it to account.
    const found = detectKind(
      ["Full Name", "Mobile", "Email", "GSTIN"],
      [["Ashok", "9876543210", "a@x.com", "27AAPFU0939F1ZV"]],
    );
    expect(found.kind).toBe("contact");
  });

  it("lets an IFSC column push an otherwise bare file towards a bank statement", () => {
    const bare = detectKind(["Date", "Description", "Amount", "Code"]);
    const withIfsc = detectKind(
      ["Date", "Description", "Amount", "Code"],
      [["01/09/2026", "NEFT", "1000", "HDFC0001234"], ["02/09/2026", "NEFT", "2000", "ICIC0000123"]],
    );
    expect(withIfsc.kind).toBe("bank_txn");
    expect(withIfsc.confidence).toBeGreaterThanOrEqual(bare.confidence);
  });

  it("offers runners-up so the picker can pre-sort", () => {
    const found = detectKind(["Date", "Amount", "Vendor", "Category", "Narration", "Balance"]);
    expect(found.alternatives.length).toBeGreaterThan(0);
    expect(found.alternatives[0].score).toBeLessThanOrEqual(10);
  });

  it("is less confident when two kinds score alike", () => {
    const clear = detectKind(["Employee Code", "Basic", "Gross Pay", "UAN", "DOJ"]);
    const muddy = detectKind(["Date", "Amount", "Status"]);
    expect(clear.confidence).toBeGreaterThan(muddy.confidence);
  });
});

describe("detectSource", () => {
  it("recognises the known export shapes §3 names", () => {
    expect(detectSource(["settlement_id", "payment_id", "amount"])).toBe("razorpay_settlement");
    expect(detectSource(["Supplier GSTIN", "ITC Available"])).toBe("gstr2b");
    expect(detectSource(["Voucher Type", "Particulars"])).toBe("tally_export");
    expect(detectSource(["Date", "Narration", "Closing Balance"])).toBe("bank_statement");
  });

  it("reads the file name as well as the headers", () => {
    expect(detectSource(["Date", "Amount"], "razorpay-settlement-sep.xlsx")).toBe("razorpay_settlement");
  });

  it("returns generic rather than offering the wrong template", () => {
    expect(detectSource(["My Column", "Another"])).toBe("generic");
  });
});

describe("rowFingerprint", () => {
  it("prefers a reference over a date-and-amount combination", () => {
    const key = rowFingerprint("payment", {
      reference: "AXIS0098122",
      paidAt: "2026-09-17",
      amount: "1000",
      customer: "Ashok",
    });
    expect(key).toBe("payment|reference|axis0098122");
  });

  it("falls back to the composite key when there is no reference", () => {
    expect(rowFingerprint("payment", { paidAt: "2026-09-17", amount: "1000", customer: "Ashok" })).toBe(
      "payment|paidAt+amount+customer|2026-09-17|1000|ashok",
    );
  });

  it("normalises case and spacing, so two spellings of one name collide", () => {
    const a = rowFingerprint("account", { name: "Shah  &  Sons" });
    const b = rowFingerprint("account", { name: "shah & sons" });
    expect(a).toBe(b);
  });

  it("is readable, so a skipped row can be explained", () => {
    expect(rowFingerprint("account", { gstin: "27AAPFU0939F1ZV" })).toContain("27aapfu0939f1zv");
  });

  it("is null when no key field is filled, so the row counts as new", () => {
    expect(rowFingerprint("payment", { customer: "Ashok" })).toBeNull();
    expect(rowFingerprint("payment", { reference: "   " })).toBeNull();
  });

  it("is null for a kind with no natural key", () => {
    expect(rowFingerprint("call_log", { anything: "x" })).toBeNull();
  });
});

describe("findDuplicatesInFile", () => {
  it("reports the LATER copies, not the first", () => {
    const rows = [
      { reference: "UTR1" },
      { reference: "UTR2" },
      { reference: "UTR1" },
      { reference: "UTR1" },
    ];
    const report = findDuplicatesInFile("payment", rows);
    expect(report.duplicateRows).toEqual([2, 3]);
    expect(report.groups["payment|reference|utr1"]).toEqual([0, 2, 3]);
  });

  it("finds nothing in a clean file", () => {
    const report = findDuplicatesInFile("payment", [{ reference: "A" }, { reference: "B" }]);
    expect(report.duplicateRows).toEqual([]);
    expect(report.groups).toEqual({});
  });

  it("lists rows it cannot key separately from duplicates", () => {
    const report = findDuplicatesInFile("payment", [{ customer: "Ashok" }, { reference: "A" }]);
    expect(report.unkeyedRows).toEqual([0]);
    expect(report.duplicateRows).toEqual([]);
  });

  it("de-duplicates on the composite key when references are absent", () => {
    const rows = [
      { paidAt: "2026-09-17", amount: "1000", customer: "Ashok" },
      { paidAt: "2026-09-17", amount: "1000", customer: "ashok" },
    ];
    expect(findDuplicatesInFile("payment", rows).duplicateRows).toEqual([1]);
  });

  it("keeps two genuinely different payments on the same day apart", () => {
    const rows = [
      { paidAt: "2026-09-17", amount: "1000", customer: "Ashok" },
      { paidAt: "2026-09-17", amount: "1000", customer: "Priya" },
    ];
    expect(findDuplicatesInFile("payment", rows).duplicateRows).toEqual([]);
  });
});

describe("the dry run §3 step 8 asks for", () => {
  it("reads as the sentence §3 writes", () => {
    expect(
      describeDryRun({ newRows: 120, updateRows: 15, skippedRows: 4, errorRows: 6, duplicateRows: 4, totalRows: 145 }),
    ).toBe("120 new, 15 updates, 4 skipped, 6 errors");
  });

  it("singularises one update and one error", () => {
    expect(
      describeDryRun({ newRows: 0, updateRows: 1, skippedRows: 0, errorRows: 1, duplicateRows: 0, totalRows: 2 }),
    ).toBe("0 new, 1 update, 0 skipped, 1 error");
  });

  it("knows when there is nothing to apply", () => {
    const empty = { newRows: 0, updateRows: 0, skippedRows: 3, errorRows: 2, duplicateRows: 3, totalRows: 5 };
    expect(dryRunIsEmpty(empty)).toBe(true);
    expect(dryRunIsEmpty({ ...empty, newRows: 1 })).toBe(false);
  });
});
