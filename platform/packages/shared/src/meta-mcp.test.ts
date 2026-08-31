import { describe, expect, it } from "vitest";
import { normalizeLeads, phoneDigits } from "./meta-mcp";

/** Meta's own wire shape, as a thin MCP wrapper would pass it through. */
const META_SHAPE = {
  data: [
    {
      id: "lead_1",
      created_time: "2026-08-28T10:00:00+0000",
      form_id: "form_99",
      form_name: "3D Website — Showroom enquiry",
      campaign_name: "Diwali push",
      page_id: "page_5",
      field_data: [
        { name: "full_name", values: ["Rajesh Kumar"] },
        { name: "email", values: ["rajesh@example.com"] },
        { name: "phone_number", values: ["+91 97899 61631"] },
        { name: "what_are_you_interested_in", values: ["A 3d site for our showroom"] },
      ],
    },
  ],
};

describe("normalizeLeads", () => {
  it("reads Meta's field_data shape", () => {
    const [lead] = normalizeLeads(META_SHAPE);
    expect(lead.leadgenId).toBe("lead_1");
    expect(lead.fullName).toBe("Rajesh Kumar");
    expect(lead.email).toBe("rajesh@example.com");
    expect(lead.phone).toBe("+91 97899 61631");
    expect(lead.pageId).toBe("page_5");
    expect(lead.formId).toBe("form_99");
  });

  it("accepts a bare array, {data}, and {leads} alike", () => {
    const bare = normalizeLeads(META_SHAPE.data);
    const wrapped = normalizeLeads({ leads: META_SHAPE.data });
    expect(bare).toEqual(normalizeLeads(META_SHAPE));
    expect(wrapped).toEqual(bare);
  });

  it("accepts a flattened lead with no field_data", () => {
    const [lead] = normalizeLeads([
      { id: "l2", full_name: "Asha", email: "a@b.com", phone: "9876543210" },
    ]);
    expect(lead).toMatchObject({ leadgenId: "l2", fullName: "Asha", phone: "9876543210" });
  });

  it("tolerates camelCase keys, since not every server snake-cases", () => {
    const [lead] = normalizeLeads([
      { leadgen_id: "l3", formId: "f1", pageId: "p1", createdTime: "2026-01-01T00:00:00Z", fieldData: [{ name: "email", values: ["x@y.z"] }] },
    ]);
    expect(lead).toMatchObject({ leadgenId: "l3", formId: "f1", pageId: "p1", email: "x@y.z" });
  });

  it("coerces numeric ids to strings so the idempotency key is one type", () => {
    const [lead] = normalizeLeads([{ id: 12345, page_id: 678 }]);
    expect(lead.leadgenId).toBe("12345");
    expect(lead.pageId).toBe("678");
  });

  /**
   * The id IS the idempotency key. Synthesising one would let the same lead
   * be re-ingested on every sweep, forever.
   */
  it("drops a lead with no id rather than inventing one", () => {
    expect(normalizeLeads([{ full_name: "No id" }, { id: "", full_name: "Blank" }])).toEqual([]);
  });

  it("returns nothing for a shape it does not recognise", () => {
    for (const payload of [null, undefined, "text", 42, {}, { results: [] }]) {
      expect(normalizeLeads(payload)).toEqual([]);
    }
  });

  it("skips a malformed entry without losing the good ones beside it", () => {
    const leads = normalizeLeads([{ id: "ok" }, { id: { nested: true } }, 42, null, { id: "ok2" }]);
    expect(leads.map((l) => l.leadgenId)).toEqual(["ok", "ok2"]);
  });

  /**
   * The text is what project detection runs over, so the form/campaign names
   * being in it is the whole reason an ad lead arrives already labelled.
   */
  it("builds match text from the form, campaign and every answer", () => {
    const [lead] = normalizeLeads(META_SHAPE);
    expect(lead.text).toContain("3D Website — Showroom enquiry");
    expect(lead.text).toContain("Diwali push");
    expect(lead.text).toContain("A 3d site for our showroom");
    // The contact's own details ride along; harmless, and a name that happens
    // to contain a project word is not a plausible false positive worth the
    // complexity of excluding.
    expect(lead.text).toContain("Rajesh Kumar");
  });

  it("leaves missing contact details null rather than guessing", () => {
    const [lead] = normalizeLeads([{ id: "l9", field_data: [{ name: "budget", values: ["50000"] }] }]);
    expect(lead.fullName).toBeNull();
    expect(lead.email).toBeNull();
    expect(lead.phone).toBeNull();
    expect(lead.text).toBe("50000");
  });

  it("ignores a field present but empty", () => {
    const [lead] = normalizeLeads([
      { id: "l10", field_data: [{ name: "email", values: [""] }, { name: "phone_number", values: [] }] },
    ]);
    expect(lead.email).toBeNull();
    expect(lead.phone).toBeNull();
  });
});

describe("phoneDigits", () => {
  it("strips everything that is not a digit", () => {
    expect(phoneDigits("+91 97899-61631")).toBe("919789961631");
    expect(phoneDigits("(044) 2812 3456")).toBe("04428123456");
  });

  /**
   * A too-short string is not a phone number, and hashing one would collide
   * unrelated people onto the same contact.
   */
  it("rejects anything too short to be a number", () => {
    expect(phoneDigits("12345")).toBeNull();
    expect(phoneDigits("n/a")).toBeNull();
    expect(phoneDigits("")).toBeNull();
    expect(phoneDigits(null)).toBeNull();
  });
});
