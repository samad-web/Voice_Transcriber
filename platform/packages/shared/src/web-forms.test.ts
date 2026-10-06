import { describe, expect, it } from "vitest";
import { CustomFieldObjectType } from "./custom-fields";
import {
  EMPTY_WEB_FORM_DEFINITION,
  WEB_FORM_CUSTOM_OBJECTS,
  INTAKE_TARGET_PAYLOAD_KEY,
  WEB_FORM_HONEYPOT_FIELD,
  WEB_FORM_RESERVED_KEYS,
  WebFormDefinition,
  WebFormField,
  WebFormFieldMap,
  WebFormIntakeTarget,
  WebFormSlug,
  validateWebFormSubmission,
  visibleWebFormFields,
  webFormConsentEvidenceText,
  webFormCustomValues,
  webFormIntakePayload,
  webFormIntakeTargetsAreIntakeFields,
  webFormSlugify,
  webFormVaultPhone,
  type WebFormDefinition as Definition,
} from "./web-forms";

/** A definition that parses, so each test can vary one thing. */
function define(fields: unknown[]): Definition {
  const parsed = WebFormDefinition.safeParse({ fields });
  if (!parsed.success) throw new Error(`fixture does not parse: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
}

const NAME = { key: "name", type: "text", label: "Your name", required: true };
const PHONE = { key: "phone", type: "phone", label: "Mobile number", required: true };

describe("the field vocabulary", () => {
  it("is exactly §15's twelve types", () => {
    const parsed = (type: string) => WebFormField.safeParse({ key: "f", type, label: "F" }).success;
    for (const type of [
      "text",
      "email",
      "phone",
      "number",
      "date",
      "textarea",
      "hidden",
      "checkbox",
    ]) {
      expect(parsed(type)).toBe(true);
    }
    // The three option types and `consent` need more than a label, and are
    // covered below - what matters here is that nothing ELSE is a type.
    expect(parsed("file")).toBe(false);
    expect(parsed("signature")).toBe(false);
    expect(parsed("rating")).toBe(false);
  });

  it("refuses a picker with no options, and options on a field with no picker", () => {
    const noOptions = WebFormField.safeParse({ key: "plan", type: "select", label: "Plan" });
    expect(noOptions.success).toBe(false);

    const strayOptions = WebFormField.safeParse({
      key: "note",
      type: "text",
      label: "Note",
      options: [{ value: "a", label: "A" }],
    });
    expect(strayOptions.success).toBe(false);
  });

  it("refuses two options with the same value", () => {
    const parsed = WebFormField.safeParse({
      key: "plan",
      type: "radio",
      label: "Plan",
      options: [
        { value: "pro", label: "Pro" },
        { value: "pro", label: "Professional" },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a required hidden field - nobody can fill it in", () => {
    const parsed = WebFormField.safeParse({
      key: "campaign",
      type: "hidden",
      label: "Campaign",
      required: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a consent box with no sentence to agree to", () => {
    expect(WebFormField.safeParse({ key: "marketing", type: "consent", label: "Marketing" }).success).toBe(false);
    expect(
      WebFormField.safeParse({
        key: "marketing",
        type: "consent",
        label: "Marketing",
        consentText: "Send me product news.",
      }).success,
    ).toBe(true);
  });

  it("keeps the honeypot's name unusable as a field key", () => {
    expect(WEB_FORM_RESERVED_KEYS).toContain(WEB_FORM_HONEYPOT_FIELD);
    const parsed = WebFormField.safeParse({
      key: WEB_FORM_HONEYPOT_FIELD,
      type: "text",
      label: "Website",
    });
    // A visible field by this name would be filled in by every real person,
    // and 0078's screen() would then reject every submission as automated.
    expect(parsed.success).toBe(false);
  });
});

describe("a definition", () => {
  it("refuses two fields with the same key", () => {
    const parsed = WebFormDefinition.safeParse({
      fields: [NAME, { key: "name", type: "email", label: "Email" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a condition on a field that is not there", () => {
    const parsed = WebFormDefinition.safeParse({
      fields: [NAME, { ...PHONE, showIf: { field: "budget", op: "filled" } }],
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses TWO LEVELS of nesting - §15's one-level rule", () => {
    const parsed = WebFormDefinition.safeParse({
      fields: [
        { key: "has_crm", type: "radio", label: "Do you use a CRM?", options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ] },
        {
          key: "crm_name",
          type: "text",
          label: "Which one?",
          showIf: { field: "has_crm", op: "eq", value: "yes" },
        },
        {
          key: "crm_pain",
          type: "textarea",
          label: "What is wrong with it?",
          // One level deeper than allowed: `crm_name` is itself conditional.
          showIf: { field: "crm_name", op: "filled" },
        },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("one level");
  });

  it("allows two fields hanging off the SAME unconditional field", () => {
    // Which is the shape the one-level rule is for: a branch, not a chain.
    const parsed = WebFormDefinition.safeParse({
      fields: [
        { key: "has_crm", type: "radio", label: "CRM?", options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ] },
        { key: "crm_name", type: "text", label: "Which?", showIf: { field: "has_crm", op: "eq", value: "yes" } },
        { key: "why_not", type: "text", label: "Why not?", showIf: { field: "has_crm", op: "eq", value: "no" } },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a field that depends on itself", () => {
    const parsed = WebFormField.safeParse({
      key: "a",
      type: "text",
      label: "A",
      showIf: { field: "a", op: "filled" },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a condition whose value does not fit its operator", () => {
    const listOpWithScalar = WebFormDefinition.safeParse({
      fields: [NAME, { ...PHONE, showIf: { field: "name", op: "in", value: "x" } }],
    });
    expect(listOpWithScalar.success).toBe(false);

    const scalarOpWithList = WebFormDefinition.safeParse({
      fields: [NAME, { ...PHONE, showIf: { field: "name", op: "eq", value: ["x"] } }],
    });
    expect(scalarOpWithList.success).toBe(false);
  });

  it("defaults to no fields", () => {
    expect(WebFormDefinition.parse({})).toEqual(EMPTY_WEB_FORM_DEFINITION);
  });
});

describe("conditional visibility", () => {
  const definition = define([
    { key: "has_crm", type: "radio", label: "CRM?", options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ] },
    { key: "crm_name", type: "text", label: "Which?", required: true, showIf: { field: "has_crm", op: "eq", value: "yes" } },
  ]);

  it("hides the dependent field until the condition holds", () => {
    expect(visibleWebFormFields(definition, {}).map((f) => f.key)).toEqual(["has_crm"]);
    expect(visibleWebFormFields(definition, { has_crm: "yes" }).map((f) => f.key)).toEqual([
      "has_crm",
      "crm_name",
    ]);
    expect(visibleWebFormFields(definition, { has_crm: "no" }).map((f) => f.key)).toEqual(["has_crm"]);
  });

  it("does not require a field it is not showing", () => {
    // The single most common bug in every form builder with this feature: a
    // conditional required field that makes the form unsubmittable.
    const hidden = validateWebFormSubmission(definition, { has_crm: "no" });
    expect(hidden.ok).toBe(true);
    expect(hidden.values).not.toHaveProperty("crm_name");

    const shown = validateWebFormSubmission(definition, { has_crm: "yes" });
    expect(shown.ok).toBe(false);
    expect(shown.errors.crm_name).toBe("Which? is required");
  });

  it("drops an answer to a field that is not showing", () => {
    const result = validateWebFormSubmission(definition, { has_crm: "no", crm_name: "Zoho" });
    expect(result.values).toEqual({ has_crm: "no" });
  });
});

describe("validating one submission", () => {
  it("normalises a phone answer to E.164 and refuses an undialable one", () => {
    const definition = define([PHONE]);

    const ok = validateWebFormSubmission(definition, { phone: "98765 43210" }, { country: "IN" });
    expect(ok.ok).toBe(true);
    expect(ok.values.phone).toBe("+919876543210");

    // The spreadsheet/paste case importPhone exists for: the "+" is gone.
    const pasted = validateWebFormSubmission(definition, { phone: "919876543210" }, { country: "IN" });
    expect(pasted.values.phone).toBe("+919876543210");

    const junk = validateWebFormSubmission(definition, { phone: "12345" }, { country: "IN" });
    expect(junk.ok).toBe(false);
    expect(junk.errors.phone).toContain("not a valid phone number");
  });

  it("reads a phone field's own country over the workspace's", () => {
    const definition = define([{ ...PHONE, country: "GB" }]);
    const result = validateWebFormSubmission(definition, { phone: "07911 123456" }, { country: "IN" });
    expect(result.ok).toBe(true);
    expect(result.values.phone).toBe("+447911123456");
  });

  it("lowercases an email and refuses one that is not an address", () => {
    const definition = define([{ key: "email", type: "email", label: "Email", required: true }]);
    expect(validateWebFormSubmission(definition, { email: "A@B.COM" }).values.email).toBe("a@b.com");
    expect(validateWebFormSubmission(definition, { email: "nope" }).errors.email).toBe(
      "Enter a valid email address",
    );
  });

  it("refuses an option nobody offered", () => {
    const definition = define([
      { key: "plan", type: "select", label: "Plan", options: [{ value: "pro", label: "Pro" }] },
    ]);
    expect(validateWebFormSubmission(definition, { plan: "enterprise" }).ok).toBe(false);
    expect(validateWebFormSubmission(definition, { plan: "pro" }).values.plan).toBe("pro");
  });

  it("deduplicates a multiselect and refuses an unknown entry", () => {
    const definition = define([
      {
        key: "needs",
        type: "multiselect",
        label: "What do you need?",
        options: [
          { value: "calls", label: "Call recording" },
          { value: "crm", label: "CRM" },
        ],
      },
    ]);
    expect(validateWebFormSubmission(definition, { needs: ["calls", "calls", "crm"] }).values.needs).toEqual([
      "calls",
      "crm",
    ]);
    expect(validateWebFormSubmission(definition, { needs: ["calls", "dialer"] }).ok).toBe(false);
  });

  it("keeps a number a number, and honours min and max", () => {
    const definition = define([{ key: "seats", type: "number", label: "Seats", min: 1, max: 50 }]);
    expect(validateWebFormSubmission(definition, { seats: "12" }).values.seats).toBe(12);
    expect(validateWebFormSubmission(definition, { seats: "1,200" }).errors.seats).toBe("Enter 50 or less");
    expect(validateWebFormSubmission(definition, { seats: "many" }).errors.seats).toBe("Enter a number");
  });

  it("requires a ticked consent box when the form asks for one", () => {
    const definition = define([NAME]);
    const missing = validateWebFormSubmission(definition, { name: "Priya" }, { consentRequired: true });
    expect(missing.ok).toBe(false);
    expect(missing.errors._consent).toBe("Please tick this to continue");

    const given = validateWebFormSubmission(
      definition,
      { name: "Priya" },
      { consentRequired: true, consentGiven: true },
    );
    expect(given.ok).toBe(true);
  });

  it("treats an unticked optional checkbox as false rather than absent", () => {
    const definition = define([{ key: "newsletter", type: "checkbox", label: "Newsletter" }]);
    expect(validateWebFormSubmission(definition, {}).values.newsletter).toBe(false);
  });
});

describe("the intake payload", () => {
  const definition = define([
    NAME,
    PHONE,
    { key: "city", type: "text", label: "City" },
    { key: "budget_band", type: "select", label: "Budget", options: [{ value: "5l", label: "Up to 5L" }] },
  ]);
  const fieldMap: WebFormFieldMap = {
    name: { kind: "intake", field: "name" },
    phone: { kind: "intake", field: "phone" },
  };

  it("uses the payload keys 0078's WEB_FORM_MAP already reads", () => {
    const values = validateWebFormSubmission(definition, {
      name: "Priya Sharma",
      phone: "+919876543210",
      city: "Chennai",
      budget_band: "5l",
    }).values;

    const payload = webFormIntakePayload(definition, fieldMap, values);
    expect(payload.name).toBe("Priya Sharma");
    expect(payload.phone).toBe("+919876543210");
    // Unmapped answers keep their own key, so collectFacts puts them on
    // leads.facts - the submission writes nothing itself.
    expect(payload.city).toBe("Chennai");
    expect(payload.budget_band).toBe("5l");
  });

  it("every intake target maps to a key the shared map can read", () => {
    for (const target of WebFormIntakeTarget.options) {
      expect(INTAKE_TARGET_PAYLOAD_KEY[target]).toBeTruthy();
    }
    // And every target is a real intake field, so renaming one over there
    // cannot leave a dead picker over here.
    expect(webFormIntakeTargetsAreIntakeFields()).toBe(true);
  });

  it("builds the enquiry text from the unmapped answers when nothing maps to notes", () => {
    const values = validateWebFormSubmission(definition, {
      name: "Priya",
      phone: "+919876543210",
      city: "Chennai",
    }).values;
    const payload = webFormIntakePayload(definition, fieldMap, values);
    expect(payload.message).toBe("City: Chennai");
  });

  it("joins two fields mapped to one target rather than losing one", () => {
    const twoPhones = define([PHONE, { key: "alt_phone", type: "phone", label: "Alternate" }]);
    const map: WebFormFieldMap = {
      phone: { kind: "intake", field: "phone" },
      alt_phone: { kind: "intake", field: "phone" },
    };
    const payload = webFormIntakePayload(twoPhones, map, {
      phone: "+919876543210",
      alt_phone: "+919812345678",
    });
    expect(payload.phone).toBe("+919876543210, +919812345678");
  });

  it("only offers the two objects a submission actually creates", () => {
    // `CustomFieldObjectType` is contact|account|deal|resource and grows as
    // verticals land (0165 added `resource`). Intake creates a contact and a
    // deal and nothing else, so anything added to that enum must NOT silently
    // become a form target - it would be a picker that drops the answer.
    expect([...WEB_FORM_CUSTOM_OBJECTS]).toEqual(["contact", "deal"]);
    for (const objectType of CustomFieldObjectType.options) {
      if (objectType === "contact" || objectType === "deal") continue;
      expect(WEB_FORM_CUSTOM_OBJECTS).not.toContain(objectType);
    }
  });

  it("keeps custom-field targets out of the payload", () => {
    const map: WebFormFieldMap = {
      city: { kind: "custom", objectType: "contact", fieldId: "11111111-1111-4111-8111-111111111111" },
    };
    const payload = webFormIntakePayload(definition, map, { city: "Chennai" });
    expect(payload.city).toBeUndefined();
    expect(webFormCustomValues(map, { city: "Chennai" })).toEqual([
      { objectType: "contact", fieldId: "11111111-1111-4111-8111-111111111111", value: "Chennai" },
    ]);
  });
});

describe("the number that goes in the vault", () => {
  it("prefers the field mapped to phone", () => {
    const definition = define([
      { key: "alt_phone", type: "phone", label: "Alternate" },
      PHONE,
    ]);
    const map: WebFormFieldMap = { phone: { kind: "intake", field: "phone" } };
    expect(
      webFormVaultPhone(definition, map, { alt_phone: "+919812345678", phone: "+919876543210" }),
    ).toBe("+919876543210");
  });

  it("falls back to the first phone field in definition order", () => {
    const definition = define([
      { key: "alt_phone", type: "phone", label: "Alternate" },
      PHONE,
    ]);
    expect(webFormVaultPhone(definition, {}, { alt_phone: "+919812345678", phone: "+919876543210" })).toBe(
      "+919812345678",
    );
  });

  it("is null for a form with no phone field at all", () => {
    expect(webFormVaultPhone(define([NAME]), {}, { name: "Priya" })).toBeNull();
  });
});

describe("slugs", () => {
  it("turns a name into one URL path segment", () => {
    expect(webFormSlugify("Request a callback!")).toBe("request-a-callback");
    expect(webFormSlugify("  Spaced   out  ")).toBe("spaced-out");
    expect(webFormSlugify("??")).toBe("form");
  });

  it("refuses anything that is not one path segment", () => {
    expect(WebFormSlug.safeParse("contact-us").success).toBe(true);
    expect(WebFormSlug.safeParse("Contact-Us").success).toBe(false);
    expect(WebFormSlug.safeParse("a/b").success).toBe(false);
    expect(WebFormSlug.safeParse("embed.js").success).toBe(false);
    expect(WebFormSlug.safeParse("-lead").success).toBe(false);
  });
});

describe("consent evidence", () => {
  it("is version-prefixed, so two wordings are distinguishable without a migration", () => {
    const text = webFormConsentEvidenceText("You may call me about this.");
    expect(text).toMatch(/^\[\d{4}-\d{2}-\d{2}\.\d\] /);
    expect(text).toContain("You may call me about this.");
  });

  it("falls back to the default sentence rather than storing an empty string", () => {
    expect(webFormConsentEvidenceText("   ")).toContain("I agree to be contacted");
    expect(webFormConsentEvidenceText(null)).toContain("I agree to be contacted");
  });
});
