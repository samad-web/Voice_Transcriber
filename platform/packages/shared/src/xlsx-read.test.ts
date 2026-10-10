import { describe, expect, it } from "vitest";

import {
  columnIndex,
  parseCellRef,
  readXlsx,
  serialToDateKey,
  sheetToGrid,
  XlsxError,
} from "./xlsx-read";

// ─────────────────────────────────────────────────────────────────────────────
// A ZIP writer, so the fixtures are real archives rather than recorded base64.
//
// Worth the thirty lines: a recorded blob cannot be adjusted to probe one
// field, and every interesting case below (a skipped row, a date style, a
// shared string, a deflated member) is a small edit to the XML.
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function buildZip(
  files: Record<string, string>,
  opts: { compress?: boolean } = {},
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = encoder.encode(content);
    const stored = opts.compress ? await deflateRaw(raw) : raw;
    const method = opts.compress ? 8 : 0;
    const nameBytes = encoder.encode(name);
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length + stored.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(stored, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, stored.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out.buffer;
}

const WORKBOOK = `<?xml version="1.0"?><workbook><sheets>
  <sheet name="Payments" sheetId="1" r:id="rId1"/>
</sheets></workbook>`;

const RELS = `<?xml version="1.0"?><Relationships>
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/** numFmtId 14 is a built-in date; 164 is a custom one; 0 is General. */
const STYLES = `<?xml version="1.0"?><styleSheet>
  <numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="&quot;Day &quot;#,##0"/></numFmts>
  <cellXfs count="5">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
    <xf numFmtId="164"/>
    <xf numFmtId="165"/>
    <xf numFmtId="4"/>
  </cellXfs>
</styleSheet>`;

async function workbookOf(sheetXml: string, extra: Record<string, string> = {}, compress = false) {
  return readXlsx(
    await buildZip(
      {
        "xl/workbook.xml": WORKBOOK,
        "xl/_rels/workbook.xml.rels": RELS,
        "xl/styles.xml": STYLES,
        "xl/worksheets/sheet1.xml": sheetXml,
        ...extra,
      },
      { compress },
    ),
  );
}

describe("cell references", () => {
  it("converts column letters to indexes", () => {
    expect([columnIndex("A"), columnIndex("Z"), columnIndex("AA"), columnIndex("AB"), columnIndex("BA")]).toEqual([
      0, 25, 26, 27, 52,
    ]);
  });

  it("rejects anything that is not a column", () => {
    expect([columnIndex("a"), columnIndex("A1"), columnIndex(""), columnIndex("1")]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("splits a cell reference", () => {
    expect(parseCellRef("B7")).toEqual({ col: 1, row: 6 });
    expect(parseCellRef("AA100")).toEqual({ col: 26, row: 99 });
  });

  it("rejects an unreadable reference", () => {
    expect([parseCellRef("7B"), parseCellRef("B"), parseCellRef("$B$7")]).toEqual([null, null, null]);
  });

  it("rejects row zero, which no sheet has", () => {
    expect(parseCellRef("B0")).toBeNull();
  });
});

describe("serialToDateKey", () => {
  it("reads a modern date serial", () => {
    // 17 September 2026 is serial 46282 in the Excel epoch.
    expect(serialToDateKey(46282)).toBe("2026-09-17");
  });

  it("reproduces the 1900 leap-year bug the way every spreadsheet does", () => {
    // Serial 61 is 1 March 1900; serial 1 is 1 January 1900.
    expect(serialToDateKey(1)).toBe("1900-01-01");
    expect(serialToDateKey(61)).toBe("1900-03-01");
  });

  it("refuses the imaginary 29 February 1900 rather than guessing a neighbour", () => {
    expect(serialToDateKey(60)).toBeNull();
  });

  it("truncates a date-time to its date", () => {
    expect(serialToDateKey(46282.75)).toBe("2026-09-17");
  });

  it("rejects nonsense", () => {
    expect([serialToDateKey(0), serialToDateKey(-5), serialToDateKey(Number.NaN)]).toEqual([null, null, null]);
  });
});

describe("readXlsx", () => {
  it("reads inline strings and numbers", async () => {
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Customer</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Ashok Sharma</t></is></c><c r="B2"><v>102500.5</v></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0].name).toBe("Payments");
    expect(wb.sheets[0].rows).toEqual([
      ["Customer", "Amount"],
      ["Ashok Sharma", 102500.5],
    ]);
  });

  it("resolves shared strings through the string table", async () => {
    const shared = `<?xml version="1.0"?><sst count="2" uniqueCount="2">
      <si><t>Invoice</t></si><si><t>Priya Raman</t></si>
    </sst>`;
    const wb = await workbookOf(
      `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c></row>
        <row r="2"><c r="A2" t="s"><v>1</v></c></row>
      </sheetData></worksheet>`,
      { "xl/sharedStrings.xml": shared },
    );
    expect(wb.sheets[0].rows).toEqual([["Invoice"], ["Priya Raman"]]);
  });

  it("concatenates rich-text runs, so a part-bold name is not truncated", async () => {
    const shared = `<?xml version="1.0"?><sst><si><r><t>Shah </t></r><r><t>&amp; Sons</t></r></si></sst>`;
    const wb = await workbookOf(
      `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
      { "xl/sharedStrings.xml": shared },
    );
    expect(wb.sheets[0].rows[0][0]).toBe("Shah & Sons");
  });

  it("decodes XML entities, including numeric ones", async () => {
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>R &amp; D &lt;dept&gt; &quot;x&quot; &apos;y&apos; &#8377;500</t></is></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows[0][0]).toBe(`R & D <dept> "x" 'y' ₹500`);
  });

  it("turns a date-formatted number into a date key, and leaves a plain number alone", async () => {
    // s="1" is numFmtId 14 (built-in date); s="0" is General; s="4" is 0.00.
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1" s="1"><v>46282</v></c><c r="B1" s="0"><v>46282</v></c><c r="C1" s="4"><v>46282</v></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows[0]).toEqual(["2026-09-17", 46282, 46282]);
  });

  it("recognises a custom date format and not a custom numeric one", async () => {
    // s="2" is dd/mm/yyyy; s="3" is `"Day "#,##0`, whose only date-ish letter
    // is inside a quoted literal - the trap the format stripper exists for.
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1" s="2"><v>46282</v></c><c r="B1" s="3"><v>46282</v></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows[0]).toEqual(["2026-09-17", 46282]);
  });

  it("reads booleans and keeps an error cell as its error text", async () => {
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="e"><v>#REF!</v></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows[0]).toEqual([true, false, "#REF!"]);
  });

  it("takes a formula's cached value and never the formula", async () => {
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1"><f>SUM(B1:B9)</f><v>45000</v></c>
                 <c r="B1" t="str"><f>CONCATENATE("a","b")</f><v>ab</v></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows[0]).toEqual([45000, "ab"]);
  });

  it("yields null for a formula with no cached value rather than inventing one", async () => {
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1"><f>TODAY()</f></c><c r="B1" t="inlineStr"><is><t>x</t></is></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows[0]).toEqual([null, "x"]);
  });

  it("honours a row's r attribute, so a gap does not shift the rows below it", async () => {
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>header</t></is></c></row>
      <row r="4"><c r="A4" t="inlineStr"><is><t>after a gap</t></is></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows).toHaveLength(4);
    expect([wb.sheets[0].rows[0][0], wb.sheets[0].rows[1][0], wb.sheets[0].rows[3][0]]).toEqual([
      "header",
      null,
      "after a gap",
    ]);
  });

  it("honours a cell's column reference, so a skipped column keeps its position", async () => {
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows[0]).toEqual([1, null, null, 4]);
  });

  it("pads every row to the same width, so a consumer can index by column", async () => {
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>
      <row r="2"><c r="A2"><v>9</v></c></row>
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows.map((r) => r.length)).toEqual([3, 3]);
  });

  it("trims the thousand styled-but-empty rows a scrolled sheet carries", async () => {
    const trailing = Array.from({ length: 50 }, (_, i) => `<row r="${i + 3}"><c r="A${i + 3}" s="0"/></row>`).join("");
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>v</t></is></c></row>
      ${trailing}
    </sheetData></worksheet>`);
    expect(wb.sheets[0].rows).toHaveLength(2);
  });

  it("reads a deflated archive as well as a stored one", async () => {
    const wb = await workbookOf(
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>compressed</t></is></c></row></sheetData></worksheet>`,
      {},
      true,
    );
    expect(wb.sheets[0].rows[0][0]).toBe("compressed");
  });

  it("caps the rows it reads", async () => {
    const rows = Array.from(
      { length: 20 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`,
    ).join("");
    const buffer = await buildZip({
      "xl/workbook.xml": WORKBOOK,
      "xl/_rels/workbook.xml.rels": RELS,
      "xl/styles.xml": STYLES,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
    });
    const wb = await readXlsx(buffer, { maxRows: 5 });
    expect(wb.sheets[0].rows).toHaveLength(5);
  });

  it("reads several sheets and keeps their names", async () => {
    const twoSheets = `<?xml version="1.0"?><workbook><sheets>
      <sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Costs" sheetId="2" r:id="rId2"/>
    </sheets></workbook>`;
    const rels = `<?xml version="1.0"?><Relationships>
      <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
    </Relationships>`;
    const wb = await readXlsx(
      await buildZip({
        "xl/workbook.xml": twoSheets,
        "xl/_rels/workbook.xml.rels": rels,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
        "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData></worksheet>`,
      }),
    );
    expect(wb.sheets.map((s) => s.name)).toEqual(["Sales", "Costs"]);
    expect(wb.sheets[1].rows[0][0]).toBe(2);
  });

  it("skips a referenced sheet that has no worksheet part instead of failing the file", async () => {
    const twoSheets = `<?xml version="1.0"?><workbook><sheets>
      <sheet name="Real" sheetId="1" r:id="rId1"/><sheet name="Chart" sheetId="2" r:id="rId9"/>
    </sheets></workbook>`;
    const wb = await readXlsx(
      await buildZip({
        "xl/workbook.xml": twoSheets,
        "xl/_rels/workbook.xml.rels": RELS,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
      }),
    );
    expect(wb.sheets.map((s) => s.name)).toEqual(["Real"]);
  });
});

describe("readXlsx - what it refuses, and how clearly", () => {
  it("names .xls by name and says what to do about it", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(readXlsx(ole.buffer)).rejects.toThrow(/Save As to make it an \.xlsx/);
  });

  it("rejects a file that is not a ZIP at all", async () => {
    const text = new TextEncoder().encode("Customer,Amount\nAshok,1000\n");
    await expect(readXlsx(text.buffer as ArrayBuffer)).rejects.toThrow(XlsxError);
    await expect(readXlsx(text.buffer as ArrayBuffer)).rejects.toThrow(/not an \.xlsx workbook/);
  });

  it("rejects a ZIP with no workbook inside", async () => {
    await expect(readXlsx(await buildZip({ "hello.txt": "hi" }))).rejects.toThrow(/no workbook inside/);
  });

  it("rejects a workbook whose sheets are all missing", async () => {
    await expect(
      readXlsx(
        await buildZip({
          "xl/workbook.xml": `<?xml version="1.0"?><workbook><sheets></sheets></workbook>`,
        }),
      ),
    ).rejects.toThrow(/no readable sheets/);
  });

  it("rejects a truncated archive rather than returning half a sheet", async () => {
    const good = await buildZip({ "xl/workbook.xml": WORKBOOK });
    const cut = good.slice(0, good.byteLength - 40);
    await expect(readXlsx(cut)).rejects.toThrow(XlsxError);
  });
});

describe("sheetToGrid", () => {
  it("stringifies every cell with no formatting a parser would have to undo", async () => {
    const wb = await workbookOf(`<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Ashok</t></is></c><c r="B1"><v>102500.5</v></c>
                 <c r="C1" s="1"><v>46282</v></c><c r="D1" t="b"><v>1</v></c><c r="E1"/></row>
    </sheetData></worksheet>`);
    expect(sheetToGrid(wb.sheets[0])[0]).toEqual(["Ashok", "102500.5", "2026-09-17", "TRUE", ""]);
  });

  it("never writes a thousands separator a later parse would trip on", async () => {
    const wb = await workbookOf(
      `<worksheet><sheetData><row r="1"><c r="A1" s="4"><v>1234567.89</v></c></row></sheetData></worksheet>`,
    );
    expect(sheetToGrid(wb.sheets[0])[0][0]).toBe("1234567.89");
  });
});
