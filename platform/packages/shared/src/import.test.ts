import { describe, expect, it } from "vitest";
import { mapRow, suggestMapping } from "./import";

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
