/**
 * One submission of a hosted form (migration 0161, doc 39 §16).
 *
 * ── THE ASSERTION THIS FILE EXISTS FOR ─────────────────────────────────────
 *
 * §16's rule is "the submission path reuses the existing lead-intake pipeline;
 * do not fork it", and a rule like that is not kept by a comment. Two kinds of
 * test hold it:
 *
 *   BEHAVIOURAL - every successful submission reaches
 *   `LeadIntakeService.ingestPayload`, with a payload whose keys 0078's own
 *   `WEB_FORM_MAP` already resolves. If the service ever grew a write of its
 *   own, these would still pass, so:
 *
 *   STRUCTURAL - `no second write path` greps this module's own source for the
 *   statements only the intake pipeline is allowed to issue. That is the same
 *   technique `e164-disclosure.spec.ts` uses to keep the number vault down to
 *   two routes, and for the same reason: the property is about what the code
 *   DOES NOT contain, which no amount of calling it can demonstrate.
 *
 * No database. The admin pool and the org transaction are both fakes that
 * record what they were asked.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { VAULT_UPSERT_SQL } from "../suppression/vault.service";
import type { DbService } from "../../db/db.service";
import type { LeadIntakeService, IntakeResult, ResolvedSource } from "../lead-intake/lead-intake.service";
import { WebFormSubmissionService } from "./web-form-submission.service";

const ORG = "00000000-0000-4000-8000-00000000a001";
const FORM = "00000000-0000-4000-8000-00000000f001";
const EVENT = "00000000-0000-4000-8000-00000000e001";
const LEAD = "00000000-0000-4000-8000-00000000d001";
const CONTACT = "00000000-0000-4000-8000-00000000c001";

const DEFINITION = {
  fields: [
    { key: "name", type: "text", label: "Your name", required: true },
    { key: "phone", type: "phone", label: "Mobile number", required: true },
    { key: "city", type: "text", label: "City" },
  ],
};

const FIELD_MAP = {
  name: { kind: "intake", field: "name" },
  phone: { kind: "intake", field: "phone" },
};

interface Issued {
  text: string;
  values: unknown[];
}

function formRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FORM,
    org_id: ORG,
    slug: "diwali-offer",
    name: "Diwali offer",
    definition: DEFINITION,
    field_map: FIELD_MAP,
    theme: {},
    consent_required: true,
    consent_text: "You may call me about this enquiry.",
    status: "published",
    redirect_url: null,
    thank_you_text: "Thanks - we will ring you today.",
    intake_token: "a".repeat(43),
    store_full_number: true,
    country: "IN",
    ...overrides,
  };
}

function harness(
  row: Record<string, unknown> | null,
  result: Partial<IntakeResult> = {},
  orgRows: Array<{ rows: unknown[] }> = [],
) {
  const issued: Issued[] = [];
  let turn = 0;

  const db = {
    adminPool: () => ({
      query: async () => ({ rows: row ? [row] : [] }),
    }),
    withOrg: async (_orgId: string, fn: (client: unknown) => Promise<unknown>) =>
      fn({
        query: async (text: string, values: unknown[] = []) => {
          issued.push({ text, values });
          const answer = orgRows[turn] ?? { rows: [] };
          turn += 1;
          return { ...answer, rowCount: (answer.rows as unknown[]).length || 1 };
        },
      }),
  } as unknown as DbService;

  const ingestPayload = jest.fn(
    async (): Promise<IntakeResult> => ({
      outcome: "created",
      reason: null,
      eventId: EVENT,
      leadId: LEAD,
      contactId: CONTACT,
      dealId: null,
      ...result,
    }),
  );
  const resolveSource = jest.fn(
    async (): Promise<ResolvedSource> =>
      ({ id: "src", orgId: ORG, kind: "web_form", provider: "generic", status: "active" }) as ResolvedSource,
  );
  const intake = { ingestPayload, resolveSource } as unknown as LeadIntakeService;

  return { service: new WebFormSubmissionService(db, intake), ingestPayload, resolveSource, issued };
}

const ANSWERS = { name: "Priya Sharma", phone: "98765 43210", city: "Chennai" };

describe("resolving the form", () => {
  it("404s a slug nobody has", async () => {
    const { service } = harness(null);
    await expect(service.submit("nope", { answers: ANSWERS, consent: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("404s a DRAFT and a CLOSED form identically", async () => {
    for (const status of ["draft", "closed"]) {
      const { service, ingestPayload } = harness(formRow({ status }));
      await expect(service.submit("diwali-offer", { answers: ANSWERS, consent: true })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(ingestPayload).not.toHaveBeenCalled();
    }
  });

  it("serves the published form without its token, its org or its field map", async () => {
    const { service } = harness(formRow());
    const form = await service.publicForm("diwali-offer");
    expect(form.slug).toBe("diwali-offer");
    expect(form.definition.fields).toHaveLength(3);
    // Everything in the response is already rendered into a public page.
    // These three are not, and one of them is a credential.
    expect(JSON.stringify(form)).not.toContain("a".repeat(43));
    expect(JSON.stringify(form)).not.toContain(ORG);
    expect(form).not.toHaveProperty("fieldMap");
  });
});

describe("field validation happens BEFORE anything is written", () => {
  it("400s a bad answer and never reaches the pipeline", async () => {
    const { service, ingestPayload, resolveSource } = harness(formRow());
    await expect(
      service.submit("diwali-offer", { answers: { name: "Priya", phone: "12345" }, consent: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveSource).not.toHaveBeenCalled();
    expect(ingestPayload).not.toHaveBeenCalled();
  });

  it("400s a missing consent tick when the form asks for one", async () => {
    const { service, ingestPayload } = harness(formRow());
    await expect(service.submit("diwali-offer", { answers: ANSWERS })).rejects.toThrow(BadRequestException);
    expect(ingestPayload).not.toHaveBeenCalled();
  });

  it("400s a submission with no name, phone or email rather than silently rejecting it", async () => {
    // The pipeline's own predicate, applied early. Left to the pipeline it
    // would be recorded as `rejected` and the visitor would get a thank-you
    // page over a lead nobody can act on.
    const row = formRow({
      definition: { fields: [{ key: "city", type: "text", label: "City" }] },
      field_map: {},
    });
    const { service, ingestPayload } = harness(row);
    await expect(
      service.submit("diwali-offer", { answers: { city: "Chennai" }, consent: true }),
    ).rejects.toThrow(BadRequestException);
    expect(ingestPayload).not.toHaveBeenCalled();
  });
});

describe("the hand-off to the existing pipeline", () => {
  it("calls ingestPayload with keys WEB_FORM_MAP already reads", async () => {
    const { service, ingestPayload } = harness(formRow());
    await service.submit("diwali-offer", {
      answers: ANSWERS,
      consent: true,
      submissionId: "3f1e4a2b-0c1d-4e2f-8a3b-4c5d6e7f8091",
      context: { pageUrl: "https://acme.com/offer", utm: { utm_source: "google" } },
    });

    expect(ingestPayload).toHaveBeenCalledTimes(1);
    const [, request] = ingestPayload.mock.calls[0] as unknown as [ResolvedSource, { payload: Record<string, unknown> }];
    expect(request.payload.name).toBe("Priya Sharma");
    // Normalised on the way in, so the pipeline never sees "98765 43210".
    expect(request.payload.phone).toBe("+919876543210");
    // Unmapped, so it keeps its own key and collectFacts puts it on
    // leads.facts - nothing in this module writes it.
    expect(request.payload.city).toBe("Chennai");
    expect(request.payload.utm_source).toBe("google");
    expect(request.payload.submission_id).toBe("3f1e4a2b-0c1d-4e2f-8a3b-4c5d6e7f8091");
  });

  it("generates a submission id when the browser sent none", async () => {
    const { service, ingestPayload } = harness(formRow());
    await service.submit("diwali-offer", { answers: ANSWERS, consent: true });
    const [, request] = ingestPayload.mock.calls[0] as unknown as [ResolvedSource, { payload: Record<string, unknown> }];
    expect(String(request.payload.submission_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes the honeypot through untouched rather than deciding it here", async () => {
    // 0078's screen() owns that decision, and it records the refusal in the
    // ledger where a tenant can see it. Re-deciding it here would be the fork.
    const { service, ingestPayload } = harness(formRow(), { outcome: "rejected", leadId: null, eventId: EVENT });
    const answer = await service.submit("diwali-offer", {
      answers: ANSWERS,
      consent: true,
      honeypot: "http://spam.example",
    });
    const [, request] = ingestPayload.mock.calls[0] as unknown as [ResolvedSource, { payload: Record<string, unknown> }];
    expect(request.payload.company_website).toBe("http://spam.example");
    // And the bot is told nothing: a refusal looks exactly like a success.
    expect(answer.ok).toBe(true);
  });

  it("forwards the browser's origin so the source's list can be applied", async () => {
    const { service, ingestPayload } = harness(formRow());
    await service.submit("diwali-offer", { answers: ANSWERS, consent: true, origin: "https://acme.com" });
    const [, request] = ingestPayload.mock.calls[0] as unknown as [ResolvedSource, { origin: string | null }];
    expect(request.origin).toBe("https://acme.com");
  });
});

describe("§16's one addition: the number vault", () => {
  function vaultCall(issued: Issued[]) {
    return issued.find((statement) => statement.text === VAULT_UPSERT_SQL);
  }

  it("writes the number with source web_form and the consent sentence AS RENDERED", async () => {
    const { service, issued } = harness(formRow());
    await service.submit("diwali-offer", {
      answers: ANSWERS,
      consent: true,
      submissionId: "3f1e4a2b-0c1d-4e2f-8a3b-4c5d6e7f8091",
    });

    const call = vaultCall(issued);
    expect(call).toBeDefined();
    expect(call!.values[2]).toBe("+919876543210");
    expect(call!.values[4]).toBe("web_form");
    // consent_required -> consent_given. §16's mapping, exactly.
    expect(call!.values[5]).toBe("consent_given");

    const evidence = JSON.parse(String(call!.values[6]));
    expect(evidence.kind).toBe("web_form");
    expect(evidence.form_slug).toBe("diwali-offer");
    // Version-prefixed, so two wordings are distinguishable without a
    // migration and editing the form tomorrow cannot rewrite this.
    expect(evidence.consent_text).toMatch(/^\[\d{4}-\d{2}-\d{2}\.\d\] You may call me about this enquiry\.$/);
    expect(evidence.submission_id).toBe("3f1e4a2b-0c1d-4e2f-8a3b-4c5d6e7f8091");
    // Both ids: what the browser said, and what we recorded.
    expect(evidence.intake_event_id).toBe(EVENT);
    expect(evidence.lead_id).toBe(LEAD);
  });

  it("records customer_initiated when the form asked for no consent", async () => {
    const { service, issued } = harness(formRow({ consent_required: false, consent_text: null }));
    await service.submit("diwali-offer", { answers: ANSWERS });
    const call = vaultCall(issued);
    expect(call!.values[5]).toBe("customer_initiated");
    expect(JSON.parse(String(call!.values[6])).consent_text).toBeNull();
  });

  it("writes NOTHING while 0011's switch is off", async () => {
    // 0157's contract for the whole subsystem, not only for the call path.
    const { service, issued } = harness(formRow({ store_full_number: false }));
    await service.submit("diwali-offer", { answers: ANSWERS, consent: true });
    expect(vaultCall(issued)).toBeUndefined();
  });

  it("writes nothing for a form with no phone field", async () => {
    const row = formRow({
      definition: { fields: [{ key: "email", type: "email", label: "Email", required: true }] },
      field_map: { email: { kind: "intake", field: "email" } },
    });
    const { service, issued } = harness(row);
    await service.submit("diwali-offer", { answers: { email: "priya@example.com" }, consent: true });
    expect(vaultCall(issued)).toBeUndefined();
  });

  it("does not cost the tenant the lead when it fails", async () => {
    // vault.service.ts's rule, applied to this path: the vault is a side
    // effect of the request, never its purpose.
    const db = {
      adminPool: () => ({ query: async () => ({ rows: [formRow()] }) }),
      withOrg: async () => {
        throw new Error("connection lost");
      },
    } as unknown as DbService;
    const intake = {
      resolveSource: jest.fn(async () => ({ id: "src", orgId: ORG }) as ResolvedSource),
      ingestPayload: jest.fn(
        async (): Promise<IntakeResult> => ({
          outcome: "created",
          reason: null,
          eventId: EVENT,
          leadId: LEAD,
          contactId: CONTACT,
          dealId: null,
        }),
      ),
    } as unknown as LeadIntakeService;

    const service = new WebFormSubmissionService(db, intake);
    await expect(service.submit("diwali-offer", { answers: ANSWERS, consent: true })).resolves.toMatchObject({
      ok: true,
      outcome: "created",
    });
  });

  it("is not attempted at all when no lead was written", async () => {
    const { service, issued } = harness(formRow(), { outcome: "duplicate", leadId: null, eventId: null });
    await service.submit("diwali-offer", { answers: ANSWERS, consent: true });
    expect(issued).toHaveLength(0);
  });
});

describe("custom field answers", () => {
  it("land on the contact intake produced, as human provenance", async () => {
    const row = formRow({
      field_map: { ...FIELD_MAP, city: { kind: "custom", objectType: "contact", fieldId: "11111111-1111-4111-8111-111111111111" } },
    });
    const { service, issued } = harness(row, {}, [
      { rows: [] }, // the vault upsert
      {
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            key: "city",
            label: "City",
            type: "text",
            object_type: "contact",
            required: false,
            options: [],
            validation: null,
          },
        ],
      },
    ]);
    await service.submit("diwali-offer", { answers: ANSWERS, consent: true });

    const write = issued.find((statement) => statement.text.includes("contact_custom_field_values"));
    expect(write).toBeDefined();
    expect(write!.text).toContain("INSERT INTO contact_custom_field_values");
    expect(write!.values).toEqual([ORG, CONTACT, "11111111-1111-4111-8111-111111111111", "Chennai"]);
    // `'human'` - a person typed it - and no updated_by, because the person
    // who typed it is the customer and has no users row.
    expect(write!.text).toContain("'human'");
    expect(write!.text).toContain("updated_by = NULL");
  });

  it("skips a field that has been deleted since the form was saved", async () => {
    const row = formRow({
      field_map: { ...FIELD_MAP, city: { kind: "custom", objectType: "contact", fieldId: "11111111-1111-4111-8111-111111111111" } },
    });
    const { service, issued } = harness(row, {}, [{ rows: [] }, { rows: [] }]);
    await service.submit("diwali-offer", { answers: ANSWERS, consent: true });
    // The lead is already on the board and the answer is already in the
    // payload. Losing placement beats losing the submission.
    expect(issued.find((s) => s.text.includes("custom_field_values INSERT"))).toBeUndefined();
    expect(issued.some((s) => s.text.includes("UPDATE web_forms SET submit_count"))).toBe(true);
  });
});

/**
 * Comments out, so the grep below reads CODE.
 *
 * Not fussiness: this module's own headers quote the statements they promise
 * never to issue, and the first run of that test failed on the sentence "there
 * is no INSERT INTO leads in this file". A denylist that a comment can trip is
 * a denylist somebody eventually deletes.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/^[ \t]*\/\/.*$/gmu, " ");
}

describe("no second write path", () => {
  const DIR = __dirname;
  const sources = readdirSync(DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => ({ file, text: codeOnly(readFileSync(join(DIR, file), "utf8")) }));

  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThan(3);
  });

  /**
   * The statements only the intake pipeline may issue.
   *
   * `web_forms` and the custom-field value tables are this module's own and
   * are excluded by naming the forbidden tables rather than the allowed ones -
   * a denylist is the right shape here because the failure being prevented is
   * somebody ADDING a write, not somebody removing one.
   */
  const FORBIDDEN = [
    /INSERT\s+INTO\s+leads\b/i,
    /INSERT\s+INTO\s+contacts\b/i,
    /INSERT\s+INTO\s+deals\b/i,
    /INSERT\s+INTO\s+lead_intake_events\b/i,
    /INSERT\s+INTO\s+lead_assignments\b/i,
  ];

  it.each(FORBIDDEN.map((pattern) => [String(pattern)] as const))(
    "never issues %s - that belongs to the lead-intake pipeline",
    (pattern) => {
      const regex = new RegExp(pattern.slice(1, pattern.lastIndexOf("/")), "i");
      const offenders = sources.filter((source) => regex.test(source.text)).map((source) => source.file);
      expect(offenders).toEqual([]);
    },
  );

  it("reaches the pipeline through LeadIntakeService and nothing else", () => {
    const submission = sources.find((source) => source.file === "web-form-submission.service.ts");
    expect(submission).toBeDefined();
    expect(submission!.text).toContain("this.intake.ingestPayload");
    // `ingestOnClient` is the pipeline's own internal entry point for a caller
    // that already holds a transaction. Using it here would mean copying
    // ingestPayload's realtime publish and error recording - orchestration
    // forked in order to avoid forking the pipeline.
    expect(submission!.text).not.toContain(".ingestOnClient(");
  });
});
