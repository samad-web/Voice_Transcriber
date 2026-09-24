/**
 * The import route handler (X7): what it refuses before it spends an API call,
 * and that a 5,000-row body - which a Server Action's 1 MB cap refused - goes
 * through. Session and API are stubbed; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_MAX_ROWS, IMPORT_RUN_MAX_BYTES } from "@aura/shared";

const getOwner = vi.fn();
vi.mock("@/lib/owner-context", () => ({ getOwner: () => getOwner() }));
vi.mock("@/lib/server-api", () => ({
  API_URL: "http://api.test",
  orgHeaders: (orgId: string, caller: { userId: string }) => ({
    "content-type": "application/json",
    "x-org-id": orgId,
    "x-caller-user-id": caller.userId,
  }),
}));

const { POST } = await import("./route");

const OWNER = { userId: "u-1", membership: { orgId: "org-1", ownerRole: "marketing" } };
const HOST = "aura.example.test";

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://${HOST}/admin/owner/import/run`, {
    method: "POST",
    headers: {
      host: HOST,
      origin: `https://${HOST}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      ...headers,
    },
    body,
  });
}

/** A 5,000-row contact run, plain ASCII - still over the old 1 MB action cap (asserted below). */
function fiveThousandRows(): string {
  const rows = Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => ({
    Name: `Customer number ${i} with a reasonably long name`,
    Email: `customer.${i}.with.a.long.address@some-company.example`,
    Phone: "+91 98765 43210",
    Title: "Senior Purchase Manager, Southern Region, Construction",
    "First name": "Customer",
    "Last name": `Number ${i}`,
  }));
  return JSON.stringify({ entity: "contact", mapping: { displayName: "Name" }, dedupeStrategy: "skip", rows });
}

const fetchMock = vi.fn();

beforeEach(() => {
  getOwner.mockResolvedValue(OWNER);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ job: { id: "job-1" } }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST /owner/import/run", () => {
  it("forwards a 5,000-row run (over the old 1 MB Server Action cap) to the API as the caller", async () => {
    const body = fiveThousandRows();
    expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);

    const res = await POST(request(body));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ job: { id: "job-1" } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/v1/import/run");
    expect(init.body).toBe(body);
    // The tenant and the person come from the session, not the request.
    expect(init.headers).toMatchObject({ "x-org-id": "org-1", "x-caller-user-id": "u-1" });
  });

  it("refuses a cross-origin POST, and one with no Origin at all", async () => {
    expect((await POST(request("{}", { origin: "https://evil.example" }))).status).toBe(403);
    const noOrigin = new Request(`http://${HOST}/admin/owner/import/run`, {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: "{}",
    });
    expect((await POST(noOrigin)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the forwarded host nginx names", async () => {
    const res = await POST(request("{}", { host: "127.0.0.1:3000", "x-forwarded-host": HOST }));
    expect(res.status).toBe(200);
  });

  it("refuses a body that is not JSON-typed - a cross-site form cannot send one without a preflight", async () => {
    expect((await POST(request("{}", { "content-type": "text/plain" }))).status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body over IMPORT_RUN_MAX_BYTES with a sentence, before calling the API", async () => {
    const res = await POST(request("{}", { "content-length": String(IMPORT_RUN_MAX_BYTES + 1) }));
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/Split the file/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    getOwner.mockResolvedValue(null);
    expect((await POST(request("{}"))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the API's refusal through as a readable error", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "requires owner role: owner or manager or marketing" }), { status: 403 }));
    const res = await POST(request("{}"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "requires owner role: owner or manager or marketing" });
  });
});
