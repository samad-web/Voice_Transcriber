/**
 * X7: a 5,000-row import must fit through `POST /v1/import/run`, and nothing
 * else may get the bigger limit.
 *
 * A real Nest + express app on an ephemeral port, wired the way main.ts wires
 * it (route-scoped import parser, then the global 1 MB parser, then the `v1`
 * prefix) around a stand-in controller - the point is the body parsers, not
 * the importer. No database, no AppModule (whose ConfigModule would read
 * `.env`, which points at production).
 */
import { Body, Controller, Module, Post, type INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { IMPORT_FIELDS, IMPORT_MAX_ROWS, IMPORT_RUN_MAX_BYTES, pickMappedColumns } from "@aura/shared";
import { mountImportBodyParser } from "./import-body-limit";

@Controller()
class EchoController {
  @Post("import/run")
  run(@Body() body: { rows?: unknown[] }) {
    return { rows: body?.rows?.length ?? 0 };
  }

  @Post("reports/run")
  other(@Body() body: { rows?: unknown[] }) {
    return { rows: body?.rows?.length ?? 0 };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

/**
 * The worst realistic run: 5,000 contacts, EVERY contact column mapped, under
 * long spreadsheet headers, with names in Tamil script (three UTF-8 bytes a
 * character) and generous lengths - 80-character full names, 40-character
 * first and last names, 80-character emails and titles. Built through the
 * console's own `pickMappedColumns`, with an unmapped column in every source
 * row that must NOT travel.
 */
function worstCaseRun(rows = IMPORT_MAX_ROWS) {
  const tamil = (n: number) => "தமிழ்".repeat(Math.ceil(n / 5)).slice(0, n);
  const headers: Record<string, string> = {
    displayName: "Customer Full Name (as on ID card)",
    firstName: "Customer First / Given Name",
    lastName: "Customer Last / Family Name",
    email: "Primary Email Address (work)",
    phone: "Primary Mobile Number (WhatsApp)",
    title: "Designation / Job Title at Firm",
  };
  const cell: Record<string, (i: number) => string> = {
    displayName: () => tamil(80),
    firstName: () => tamil(40),
    lastName: () => tamil(40),
    email: (i) => `${"a".repeat(60)}.${String(i).padStart(5, "0")}@${"b".repeat(8)}.example`.slice(0, 80),
    phone: () => "+91 98765 43210",
    title: () => "T".repeat(80),
  };
  // Every contact field the importer knows is mapped - no wider entity exists.
  const mapping = Object.fromEntries(IMPORT_FIELDS.contact.map((f) => [f.field, headers[f.field]]));
  expect(Object.keys(mapping).sort()).toEqual(Object.keys(headers).sort());

  const sourceRows = Array.from({ length: rows }, (_, i) => ({
    ...Object.fromEntries(IMPORT_FIELDS.contact.map((f) => [headers[f.field], cell[f.field](i)])),
    "Internal notes (not imported)": "x".repeat(400),
  }));
  return {
    entity: "contact",
    mapping,
    dedupeStrategy: "skip",
    rows: sourceRows.map((row) => pickMappedColumns(mapping, row)),
  };
}

function bytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

describe("POST /v1/import/run body limit (X7)", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
    // main.ts order: the import route's parser, THEN the global one.
    mountImportBodyParser(nest);
    nest.useBodyParser("json", { limit: "1mb" });
    nest.setGlobalPrefix("v1");
    await nest.listen(0, "127.0.0.1");
    const address = nest.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
    app = nest;
  });

  afterAll(async () => {
    await app?.close();
  });

  const post = (path: string, payload: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  it("measures the worst realistic 5,000-row run: over the old 1 MB, well under the new cap", () => {
    const size = bytes(worstCaseRun());
    // Printed so the number behind IMPORT_RUN_MAX_BYTES's comment is on record.
    console.info(`worst-case 5,000-row contact import: ${(size / 1024 / 1024).toFixed(2)} MB`);
    expect(size).toBeGreaterThan(1024 * 1024);
    expect(size * 1.5).toBeLessThan(IMPORT_RUN_MAX_BYTES);
  });

  it("only mapped columns travel - the unmapped notes column is not in the payload", () => {
    const run = worstCaseRun(1);
    expect(Object.keys(run.rows[0])).not.toContain("Internal notes (not imported)");
    expect(Object.keys(run.rows[0])).toHaveLength(IMPORT_FIELDS.contact.length);
  });

  it("accepts that payload on /v1/import/run", async () => {
    const res = await post("/v1/import/run", worstCaseRun());
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ rows: IMPORT_MAX_ROWS });
  });

  it("still refuses the same payload on every other route - the global 1 MB stands", async () => {
    const res = await post("/v1/reports/run", worstCaseRun());
    expect(res.status).toBe(413);
  });

  it("still parses small bodies on other routes", async () => {
    const res = await post("/v1/reports/run", { rows: [1, 2, 3] });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ rows: 3 });
  });

  it("refuses an import body over IMPORT_RUN_MAX_BYTES - the new limit is bounded", async () => {
    const huge = { entity: "contact", mapping: {}, rows: [{ blob: "x".repeat(IMPORT_RUN_MAX_BYTES) }] };
    const res = await post("/v1/import/run", huge);
    expect(res.status).toBe(413);
  });
});
