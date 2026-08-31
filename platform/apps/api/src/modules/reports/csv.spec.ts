import { safeFilename, toCsv } from "./csv";

/**
 * CSV export takes one tenant's data - including display names that come from
 * call transcripts and from an open API - and writes a file an operator opens
 * in a spreadsheet. The escaping below is the whole security boundary of that
 * feature.
 */

const columns = [
  { header: "Name", value: (r: { name: string; n?: number }) => r.name },
  { header: "N", value: (r: { name: string; n?: number }) => r.n },
];

describe("toCsv", () => {
  it("writes a header row and CRLF line endings", () => {
    expect(toCsv(columns, [{ name: "Asha", n: 1 }])).toBe("Name,N\r\nAsha,1\r\n");
  });

  it("still emits the header when there are no rows", () => {
    expect(toCsv(columns, [])).toBe("Name,N\r\n");
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(toCsv(columns, [{ name: "Asha" }])).toBe("Name,N\r\nAsha,\r\n");
  });

  it("quotes values containing a comma, quote or newline", () => {
    expect(toCsv(columns, [{ name: 'Sharma, "Priya"' }])).toBe(
      'Name,N\r\n"Sharma, ""Priya""",\r\n',
    );
    expect(toCsv(columns, [{ name: "two\nlines" }])).toBe('Name,N\r\n"two\nlines",\r\n');
  });

  describe("formula injection", () => {
    // Excel/LibreOffice/Sheets execute a cell beginning with any of these.
    // Display names reach this export from call transcripts and from the
    // contacts API, so a tenant controls the content.
    it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])("neutralises %j", (payload) => {
      const out = toCsv([columns[0]], [{ name: payload }]);
      const cell = out.split("\r\n")[1];
      // Prefixed with an apostrophe, which spreadsheets strip on display.
      expect(cell.startsWith("'") || cell.startsWith('"\'')).toBe(true);
    });

    it("neutralises the classic command payload without mangling it", () => {
      const out = toCsv([columns[0]], [{ name: `=cmd|'/c calc'!A0` }]);
      expect(out).toContain(`'=cmd`);
    });

    it("leaves an ordinary name untouched", () => {
      expect(toCsv([columns[0]], [{ name: "Priya Sharma" }])).toBe("Name\r\nPriya Sharma\r\n");
    });

    it("does not mistake a negative number for a formula in a way that loses it", () => {
      // It IS prefixed - a leading '-' is genuinely a formula trigger - but the
      // value must remain readable rather than being dropped or altered.
      expect(toCsv([columns[0]], [{ name: "-42" }])).toContain("-42");
    });
  });
});

describe("safeFilename", () => {
  it("strips anything that could escape the Content-Disposition header", () => {
    expect(safeFilename('re"port\r\nX-Injected: 1')).toBe("re-port--X-Injected--1");
  });

  it("keeps ordinary report names intact", () => {
    expect(safeFilename("aura-pipeline-2026-08-12")).toBe("aura-pipeline-2026-08-12");
  });

  it("falls back to a name rather than returning empty", () => {
    // Only an input that sanitises to nothing at all takes the fallback;
    // "///" becomes "---", which is already a safe filename.
    expect(safeFilename("")).toBe("report");
    expect(safeFilename("///")).toBe("---");
  });

  it("bounds the length", () => {
    expect(safeFilename("a".repeat(200))).toHaveLength(80);
  });
});
