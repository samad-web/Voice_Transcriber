/**
 * The form builder's store (migration 0161, doc 39 §15).
 *
 * No database. What is checked here is the handful of decisions that cannot be
 * read off a schema: how a platform-unique slug is allocated without
 * disclosing another tenant's, what makes a form publishable, and what the
 * three distribution snippets actually say.
 */
import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import {
  WebFormDefinition,
  WebFormFieldMap,
  type WebFormDefinition as Definition,
  type WebFormFieldMap as FieldMap,
} from "@aura/shared/dist/web-forms";
import { ORG_A } from "../../common/guard-harness.spec";
import { WebFormsService, distributionFor, hostedFormOrigin } from "./web-forms.service";

const SOURCE = "00000000-0000-4000-8000-0000000000s1".replace("s", "a");
const FIELD = "11111111-1111-4111-8111-111111111111";

interface Issued {
  text: string;
  values: unknown[];
}

/** Answers each statement from a queue; records everything it was asked. */
function fakeClient(answers: Array<{ rows: unknown[] }>) {
  const issued: Issued[] = [];
  let turn = 0;
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      const answer = answers[turn] ?? { rows: [] };
      turn += 1;
      return { ...answer, rowCount: (answer.rows as unknown[]).length };
    }),
  } as unknown as PoolClient;
  return { client, issued };
}

function define(fields: unknown[]): Definition {
  return WebFormDefinition.parse({ fields });
}

function mapOf(raw: unknown): FieldMap {
  return WebFormFieldMap.parse(raw);
}

/**
 * The per-field messages out of a refusal, as one string.
 *
 * `validateFieldMap` throws a `BadRequestException` carrying an ARRAY of
 * `{ path, message }` - the shape the console renders beside the row that is
 * wrong. Nest's `.message` for that is the useless literal "Bad Request
 * Exception", so asserting on it would pass for every refusal including the
 * wrong one.
 */
async function issuesFrom(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof BadRequestException) return JSON.stringify(err.getResponse());
    throw err;
  }
  throw new Error("expected a BadRequestException, and nothing was thrown");
}

describe("allocating a slug", () => {
  const service = new WebFormsService();

  const values = {
    orgId: ORG_A,
    sourceId: SOURCE,
    name: "Request a callback",
    definition: { fields: [] },
    fieldMap: {},
    consentRequired: true,
    consentText: "x",
    theme: {},
    redirectUrl: null,
    thankYouText: null,
    createdBy: null,
  };

  it("slugifies the name and takes it when it is free", async () => {
    const { client, issued } = fakeClient([{ rows: [{ id: "f1" }] }]);
    const created = await service.insertWithFreeSlug(client, values);
    expect(created).toEqual({ id: "f1", slug: "request-a-callback" });
    expect(issued).toHaveLength(1);
    expect(issued[0].values[3]).toBe("request-a-callback");
  });

  it("lets the INDEX decide, not a SELECT", async () => {
    // The whole point: web_forms is RLS-FORCED and the unique index is
    // platform-wide, so a SELECT inside this org cannot see the row that would
    // collide. ON CONFLICT is index-level, so it reports the collision without
    // disclosing the row - and without aborting the transaction, which is what
    // makes the retry below possible at all.
    const { client, issued } = fakeClient([{ rows: [{ id: "f1" }] }]);
    await service.insertWithFreeSlug(client, values);
    expect(issued[0].text).toContain("ON CONFLICT (slug) DO NOTHING");
    expect(issued[0].text).not.toContain("SELECT");
  });

  it("retries with a RANDOM suffix, never a counter", async () => {
    const { client, issued } = fakeClient([{ rows: [] }, { rows: [{ id: "f2" }] }]);
    const created = await service.insertWithFreeSlug(client, values);
    expect(issued).toHaveLength(2);
    // "-2" would tell the tenant that somebody holds the bare name, and a
    // second attempt would tell them how many. Six hex characters tell them
    // nothing.
    expect(created.slug).not.toBe("request-a-callback-2");
    expect(created.slug).toMatch(/^request-a-callback-[0-9a-f]{6}$/);
  });

  it("gives up rather than looping forever", async () => {
    const { client } = fakeClient(Array.from({ length: 20 }, () => ({ rows: [] })));
    await expect(service.insertWithFreeSlug(client, values)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("honours a slug the author chose", async () => {
    const { client, issued } = fakeClient([{ rows: [{ id: "f1" }] }]);
    await service.insertWithFreeSlug(client, { ...values, slug: "diwali-offer" });
    expect(issued[0].values[3]).toBe("diwali-offer");
  });
});

describe("the lead_sources name", () => {
  const service = new WebFormsService();

  it("is the form's name when nothing in this org has it", async () => {
    const { client } = fakeClient([{ rows: [{ taken: "something else" }] }]);
    await expect(service.freeSourceName(client, "Contact us")).resolves.toBe("Contact us");
  });

  it("suffixes a number when it does - the collision is this tenant's own", async () => {
    // Unlike the slug, `lead_sources_org_kind_name` is PER-ORG, so the rows
    // that would collide are visible under RLS and there is nothing to
    // disclose by counting them.
    const { client } = fakeClient([{ rows: [{ taken: "contact us" }, { taken: "contact us 2" }] }]);
    await expect(service.freeSourceName(client, "Contact us")).resolves.toBe("Contact us 3");
  });
});

describe("what may be published", () => {
  const service = new WebFormsService();

  it("refuses a form with no fields", () => {
    expect(() => service.assertPublishable(define([]), {})).toThrow(BadRequestException);
  });

  it("refuses a form with no way to reach the person", () => {
    // Every answer would land on leads.facts, intakeRejectionReason would
    // refuse every arrival, and the tenant would find out when somebody asked
    // why the campaign produced no leads.
    const definition = define([
      { key: "city", type: "text", label: "City", required: true },
      { key: "budget", type: "number", label: "Budget" },
    ]);
    expect(() => service.assertPublishable(definition, {})).toThrow(/no way to reach the person/);
  });

  it("accepts a field MAPPED to name, phone or email", () => {
    const definition = define([{ key: "mobile", type: "phone", label: "Mobile" }]);
    expect(() =>
      service.assertPublishable(definition, mapOf({ mobile: { kind: "intake", field: "phone" } })),
    ).not.toThrow();
  });

  it("accepts an UNMAPPED field literally called phone", () => {
    // 0078's WEB_FORM_MAP reads `phone` straight off the payload, and an
    // unmapped answer keeps its own key - which is also the shape every
    // hand-built HTML form already has.
    expect(() => service.assertPublishable(define([{ key: "phone", type: "phone", label: "Mobile" }]), {})).not.toThrow();
  });

  it("does NOT accept a field called phone that was mapped somewhere else", () => {
    const definition = define([{ key: "phone", type: "phone", label: "Mobile" }]);
    expect(() =>
      service.assertPublishable(definition, mapOf({ phone: { kind: "intake", field: "notes" } })),
    ).toThrow(/no way to reach the person/);
  });
});

describe("validating the field map against the LIVE custom fields", () => {
  const service = new WebFormsService();
  const definition = define([{ key: "city", type: "text", label: "City" }]);

  it("refuses a mapping for a field that is not on the form", async () => {
    const { client } = fakeClient([]);
    await expect(
      service.validateFieldMap(client, definition, mapOf({ state: { kind: "intake", field: "notes" } })),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses an object a submission never creates", async () => {
    // Intake produces a contact and a deal. An account-scoped custom field has
    // nothing to attach to, and discovering that at submit time would mean a
    // silently dropped answer rather than a refused save.
    const { client } = fakeClient([{ rows: [] }]);
    await expect(
      issuesFrom(() =>
        service.validateFieldMap(
          client,
          definition,
          mapOf({ city: { kind: "custom", objectType: "account", fieldId: FIELD } }),
        ),
      ),
    ).resolves.toContain("cannot be stored on a account");
  });

  it("refuses a custom field that no longer exists - §15's whole point", async () => {
    const { client } = fakeClient([{ rows: [] }]);
    await expect(
      issuesFrom(() =>
        service.validateFieldMap(
          client,
          definition,
          mapOf({ city: { kind: "custom", objectType: "contact", fieldId: FIELD } }),
        ),
      ),
    ).resolves.toContain("no longer exists");
  });

  it("refuses a custom field that belongs to a different object", async () => {
    const { client } = fakeClient([
      { rows: [{ id: FIELD, key: "city", label: "City", type: "text", object_type: "deal", required: false, options: [], validation: null }] },
    ]);
    await expect(
      issuesFrom(() =>
        service.validateFieldMap(
          client,
          definition,
          mapOf({ city: { kind: "custom", objectType: "contact", fieldId: FIELD } }),
        ),
      ),
    ).resolves.toContain("but says it is a contact one");
  });

  it("only looks at ACTIVE definitions", async () => {
    const { client, issued } = fakeClient([
      { rows: [{ id: FIELD, key: "city", label: "City", type: "text", object_type: "contact", required: false, options: [], validation: null }] },
    ]);
    await service.validateFieldMap(
      client,
      definition,
      mapOf({ city: { kind: "custom", objectType: "contact", fieldId: FIELD } }),
    );
    expect(issued[0].text).toContain("status = 'active'");
  });

  it("asks the database nothing when there is nothing to ask about", async () => {
    const { client, issued } = fakeClient([]);
    await service.validateFieldMap(client, definition, mapOf({ city: { kind: "intake", field: "notes" } }));
    expect(issued).toHaveLength(0);
  });
});

describe("the distribution snippets", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("uses the MARKETING site's domain, not the console's", () => {
    // `/f/<slug>` is served by apps/marketing, which in production is the apex
    // while the console is app.<domain>. Getting this wrong produces a link
    // that 404s, on a printed card.
    process.env.SITE_DOMAIN = "example.com";
    process.env.APP_DOMAIN = "app.example.com";
    delete process.env.FORM_PUBLIC_ORIGIN;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(hostedFormOrigin(process.env)).toBe("https://example.com");
  });

  it("answers null rather than guessing localhost", () => {
    expect(hostedFormOrigin({})).toBeNull();
    expect(distributionFor("diwali", "Diwali offer")).toEqual({
      url: null,
      iframe: null,
      script: null,
      qrEncodes: null,
    });
  });

  it("points all three at ONE renderer", () => {
    process.env.FORM_PUBLIC_ORIGIN = "https://example.com";
    const dist = distributionFor("diwali", "Diwali offer");
    expect(dist.url).toBe("https://example.com/f/diwali");
    // The iframe is the hosted page; the script injects an iframe pointing at
    // the hosted page. §16: no second rendering engine.
    expect(dist.iframe).toContain("https://example.com/f/diwali?embed=1");
    expect(dist.script).toBe('<script src="https://example.com/f/diwali/embed.js" async></script>');
    expect(dist.qrEncodes).toBe(dist.url);
  });

  it("gives the iframe an accessible name", () => {
    process.env.FORM_PUBLIC_ORIGIN = "https://example.com";
    expect(distributionFor("diwali", 'Diwali "big" offer').iframe).toContain(
      'title="Diwali &quot;big&quot; offer"',
    );
  });
});
