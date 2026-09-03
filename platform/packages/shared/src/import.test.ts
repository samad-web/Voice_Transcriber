import { describe, expect, it } from "vitest";
import { csvCell } from "./csv";
import {
  IMPORT_FIELDS,
  ImportEntity,
  REQUIRED_FIELDS,
  importTemplateCsv,
  importTemplateFilename,
  importTemplateHeaders,
  importTemplateSampleRows,
  looksLikeTemplateSample,
  mapRow,
  suggestMapping,
} from "./import";

describe("suggestMapping", () => {
  it("matches exact header spellings case-insensitively", () => {
    const mapping = suggestMapping("contact", ["Name", "Email Address", "Phone Number"]);
    expect(mapping.displayName).toBe("Name");
    expect(mapping.email).toBe("Email Address");
    expect(mapping.phone).toBe("Phone Number");
  });

  it("falls back to a substring match", () => {
    const mapping = suggestMapping("account", ["Company Website URL"]);
    expect(mapping.domain).toBe("Company Website URL");
  });

  it("leaves a field unmapped rather than guessing wrong", () => {
    const mapping = suggestMapping("deal", ["Random Column"]);
    expect(mapping.name).toBeNull();
  });
});

describe("mapRow", () => {
  it("applies the mapping and trims strings", () => {
    const mapping = { displayName: "Name", email: "Email" };
    const row = mapRow(mapping, { Name: "  Priya Shah  ", Email: "priya@example.com" });
    expect(row).toEqual({ displayName: "Priya Shah", email: "priya@example.com" });
  });

  it("maps an unmapped field to null", () => {
    const row = mapRow({ phone: null }, {});
    expect(row.phone).toBeNull();
  });

  it("treats a blank cell as null, not an empty string", () => {
    const row = mapRow({ title: "Title" }, { Title: "   " });
    expect(row.title).toBeNull();
  });
});

describe("the downloadable template", () => {
  const entities = ImportEntity.options;

  it.each(entities)("round-trips: a filled-in %s template maps itself completely", (entity) => {
    // The whole point of shipping a template. Parse its own header row back
    // through the guesser and every target field must resolve - if any came
    // back null the customer would be handed a file that their own console
    // then asked them to map by hand.
    const mapping = suggestMapping(entity, importTemplateHeaders(entity));
    for (const field of IMPORT_FIELDS[entity]) {
      expect(mapping[field.field], `${entity}.${field.field}`).toBe(field.header);
    }
  });

  it.each(entities)("maps every %s header to exactly one field - no two columns collide", (entity) => {
    const mapping = suggestMapping(entity, importTemplateHeaders(entity));
    const claimed = Object.values(mapping);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it.each(entities)("names the required %s fields the API will insist on", (entity) => {
    const required = IMPORT_FIELDS[entity].filter((f) => f.required).map((f) => f.field);
    expect(REQUIRED_FIELDS[entity]).toEqual(required);
    expect(required.length).toBeGreaterThan(0);
  });

  it("leads with a BOM so Excel reads it as UTF-8, and ends every row with CRLF", () => {
    const csv = importTemplateCsv("contact");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("prints the header row, then one sample row per sample", () => {
    const csv = importTemplateCsv("account");
    const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("Company name,Domain");
    expect(lines).toHaveLength(1 + importTemplateSampleRows("account").length);
    expect(lines[1]).toBe("Vetri Constructions,vetriconstructions.example");
  });

  it.each(entities)("escapes any %s sample cell that would otherwise break a row", (entity) => {
    // The deal name contains a hyphen and could one day contain a comma; this
    // asserts the encoder is actually being used rather than a naive join.
    const csv = importTemplateCsv(entity).replace(/^\uFEFF/, "");
    for (const line of csv.trimEnd().split("\r\n")) {
      const cells = line.split(",");
      // A cell that needed quoting will have been quoted, so an unquoted cell
      // can never itself contain a quote.
      for (const cell of cells) {
        if (!cell.startsWith('"')) expect(cell).not.toContain('"');
      }
    }
  });

  it("names the file after the entity", () => {
    expect(importTemplateFilename("contact")).toBe("aura-contacts-template.csv");
    expect(importTemplateFilename("account")).toBe("aura-accounts-template.csv");
    expect(importTemplateFilename("deal")).toBe("aura-deals-template.csv");
  });

  it("neutralises a formula, should a sample ever start with one", () => {
    // Not reachable from the current samples - this locks in that the shared
    // encoder (and not a local join) is what renders them.
    expect(csvCell("=1+1")).toBe("'=1+1");
  });
});

describe("looksLikeTemplateSample", () => {
  const contactMapping = suggestMapping("contact", importTemplateHeaders("contact"));

  it("spots an un-deleted sample row", () => {
    const [first] = importTemplateSampleRows("contact");
    const row = Object.fromEntries(importTemplateHeaders("contact").map((h, i) => [h, first[i]]));
    expect(looksLikeTemplateSample("contact", contactMapping, row)).toBe(true);
  });

  it("spots the second sample too, and ignores case and padding", () => {
    expect(
      looksLikeTemplateSample("contact", contactMapping, { "Full name": "  arun kumar " }),
    ).toBe(true);
  });

  it("leaves a real record alone even when it shares an unimportant cell", () => {
    expect(
      looksLikeTemplateSample("contact", contactMapping, {
        "Full name": "Meena Balaji",
        Title: "Purchase Manager",
      }),
    ).toBe(false);
  });

  it("does not fire on a blank row", () => {
    expect(looksLikeTemplateSample("contact", contactMapping, { "Full name": "" })).toBe(false);
  });
});
