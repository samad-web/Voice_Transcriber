import { describe, expect, it } from "vitest";

import { csvHeader, csvRow, toCsv } from "./csv";

describe("csvRow / csvHeader", () => {
  interface Row {
    name: string;
    n: number;
  }
  const columns = [
    { header: "Name", value: (r: Row) => r.name },
    { header: "Count", value: (r: Row) => r.n },
  ];

  /**
   * The property that matters: a streamed file and a buffered one are the same
   * bytes. If these two ever diverge, exports and the import template stop
   * agreeing about quoting - the exact failure csv.ts exists to prevent.
   */
  it("streams byte-for-byte what toCsv would have built", () => {
    const rows: Row[] = [
      { name: "Priya", n: 1 },
      { name: 'He said "hi", loudly', n: 2 },
      { name: "line\nbreak", n: 3 },
      { name: "=cmd|'/c calc'!A0", n: 4 },
      { name: "", n: 0 },
    ];
    const streamed = csvHeader(columns) + rows.map((r) => csvRow(columns, r)).join("");
    expect(streamed).toBe(toCsv(columns, rows));
  });

  it("terminates every row, so the last one survives a naive reader", () => {
    expect(csvRow(columns, { name: "a", n: 1 })).toMatch(/\r\n$/);
    expect(csvHeader(columns)).toMatch(/\r\n$/);
  });

  it("neutralises a formula in a streamed row exactly as toCsv does", () => {
    expect(csvRow(columns, { name: "=1+1", n: 0 })).toBe("'=1+1,0\r\n");
  });
});
