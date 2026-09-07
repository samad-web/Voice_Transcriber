import { describe, expect, it } from "vitest";
import {
  parseSheetGid,
  parseSpreadsheetId,
  sheetFieldMap,
  sheetRange,
  sheetRowToPayload,
  sheetsConfigured,
} from "./lead-intake";

/**
 * The Google Sheets connector's pure half (migration 0096).
 *
 * Everything here decides what a row MEANS, which is the part that fails
 * quietly: a mapping that reads the wrong column does not throw, it creates a
 * thousand leads whose name is an email address.
 */

describe("parseSpreadsheetId", () => {
  it("takes the id out of the URL a person actually has in front of them", () => {
    // Nothing in the Google Sheets interface displays the id, so the browser
    // URL is what gets pasted - usually with a #gid on the end.
    expect(
      parseSpreadsheetId(
        "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBd_2hbGr9x/edit#gid=0",
      ),
    ).toBe("1BxiMVs0XRA5nFMdKvBd_2hbGr9x");
  });

  it("accepts a bare id for somebody who knows it", () => {
    expect(parseSpreadsheetId("1BxiMVs0XRA5nFMdKvBd2hbGr9xABCDEFGH")).toBe(
      "1BxiMVs0XRA5nFMdKvBd2hbGr9xABCDEFGH",
    );
  });

  it("refuses rather than guessing", () => {
    // A wrong id fails on the first sync as a 404 from Google, hours later and
    // nowhere near the person who pasted it. Failing at paste time is kinder.
    expect(parseSpreadsheetId("https://docs.google.com/document/d/abc/edit")).toBeNull();
    expect(parseSpreadsheetId("my leads")).toBeNull();
    expect(parseSpreadsheetId("")).toBeNull();
  });
});

describe("parseSheetGid", () => {
  it("reads the tab out of the fragment", () => {
    expect(parseSheetGid("https://docs.google.com/spreadsheets/d/abc/edit#gid=1544219")).toBe(
      "1544219",
    );
  });

  it("is null when the URL names no tab", () => {
    expect(parseSheetGid("https://docs.google.com/spreadsheets/d/abc/edit")).toBeNull();
  });
});

describe("sheetRowToPayload", () => {
  const headers = ["Name", "Mobile", "Email", "Notes"];

  it("keys on the header text, so inserting a column shifts nothing", () => {
    expect(sheetRowToPayload(headers, ["Priya", "9876543210", "p@x.com", "wants a demo"])).toEqual({
      Name: "Priya",
      Mobile: "9876543210",
      Email: "p@x.com",
      Notes: "wants a demo",
    });
  });

  it("omits missing trailing cells instead of inventing empty strings", () => {
    // Google truncates trailing empties, so a short row is the NORMAL case.
    // An empty string would satisfy the normaliser's first candidate path and
    // produce a lead with a blank name; an absent key makes it try the next.
    const out = sheetRowToPayload(headers, ["Priya", "9876543210"]);
    expect(out).toEqual({ Name: "Priya", Mobile: "9876543210" });
    expect("Email" in out).toBe(false);
  });

  it("drops blank cells in the middle for the same reason", () => {
    const out = sheetRowToPayload(headers, ["Priya", "   ", "p@x.com"]);
    expect("Mobile" in out).toBe(false);
    expect(out.Email).toBe("p@x.com");
  });

  it("keeps the first of two identically named columns", () => {
    // Google allows it, there is no correct answer, and first is the one a
    // person points at when you ask which they meant.
    expect(sheetRowToPayload(["Phone", "Phone"], ["111", "222"])).toEqual({ Phone: "111" });
  });

  it("ignores an unnamed column rather than keying on empty string", () => {
    expect(sheetRowToPayload(["Name", "", "Email"], ["Priya", "junk", "p@x.com"])).toEqual({
      Name: "Priya",
      Email: "p@x.com",
    });
  });
});

describe("sheetFieldMap", () => {
  it("inverts the console's direction into the normaliser's", () => {
    expect(sheetFieldMap({ "Full name": "name", Mobile: "phone" })).toEqual({
      name: ["Full name"],
      phone: ["Mobile"],
    });
  });

  it("keeps the leftmost column first when two mean the same thing", () => {
    // "Mobile" and "Alt phone" both meaning phone is a real spreadsheet. The
    // normaliser takes the first path that yields a value, so column order has
    // to decide - which is what somebody scanning the sheet would expect.
    const map = sheetFieldMap({ "Alt phone": "phone", Mobile: "phone" }, [
      "Name",
      "Mobile",
      "Alt phone",
    ]);
    expect(map.phone).toEqual(["Mobile", "Alt phone"]);
  });

  it("puts unknown headers last rather than dropping them", () => {
    const map = sheetFieldMap({ Ghost: "phone", Mobile: "phone" }, ["Mobile"]);
    expect(map.phone).toEqual(["Mobile", "Ghost"]);
  });
});

describe("sheetRange", () => {
  it("reads one tab from the header row down", () => {
    expect(sheetRange("Leads", 1)).toBe("'Leads'!A1:ZZ");
    expect(sheetRange("Leads", 3)).toBe("'Leads'!A3:ZZ");
  });

  it("escapes a quote in the tab name", () => {
    // `Q1 'hot' leads` is a legal tab name. Unescaped it would terminate the
    // A1 range early and read whichever tab Sheets defaulted to - silently.
    expect(sheetRange("Q1 'hot' leads")).toBe("'Q1 ''hot'' leads'!A1:ZZ");
  });

  it("falls back to the first tab when none is named", () => {
    expect(sheetRange(undefined)).toBe("A1:ZZ");
  });
});

describe("sheetsConfigured", () => {
  const full = {
    spreadsheetId: "1BxiMVs0XRA5nFMdKvBd2hbGr9x",
    connectedAccountId: "8f14e45f-ceea-4a6b-a3f4-1b2c3d4e5f60",
    columnMapping: { Mobile: "phone" as const },
  };

  it("needs a sheet, an account and at least one mapped column", () => {
    expect(sheetsConfigured(full)).toBe(true);
  });

  it("is false with an empty mapping - a sheet nobody has told us how to read", () => {
    expect(sheetsConfigured({ ...full, columnMapping: {} })).toBe(false);
  });

  it("is false without the Google account that reads it", () => {
    expect(sheetsConfigured({ ...full, connectedAccountId: undefined })).toBe(false);
  });
});
