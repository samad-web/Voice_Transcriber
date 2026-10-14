import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureError,
  errorReportingEnabled,
  initErrorReporting,
  parseDsn,
  parseStack,
  resetErrorReporting,
  scrub,
} from "./observability";

/**
 * WHAT MAY LEAVE THE PROCESS.
 *
 * This product's payload is customer call content under a signed DPA. A
 * transcript, a phone number or a presigned recording URL in a third-party
 * error tracker is a breach, not a bug - so the only assertions here that
 * matter are about what is NOT in the body we POST.
 *
 * Every test works the same way: intercept `fetch`, send something hostile,
 * and read the envelope. Asserting on the serialised body rather than on an
 * object is deliberate - a field added as a nested object, a toJSON, or a
 * getter would pass an object-shaped assertion and still be on the wire.
 */

const DSN = "https://abc123def456@errors.example.com/7";

let sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];

function envelope(index = 0): Record<string, unknown> {
  const body = sent[index]!.body;
  const lines = body.trim().split("\n");
  return JSON.parse(lines[2]!) as Record<string, unknown>;
}

/** The whole wire body, which is what a reviewer should actually grep. */
function wire(index = 0): string {
  return sent[index]!.body;
}

beforeEach(() => {
  sent = [];
  resetErrorReporting();
  vi.stubEnv("SENTRY_DSN", DSN);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ERROR_REPORT_DEDUPE_MS", "0");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      body: String(init.body),
      headers: init.headers as Record<string, string>,
    });
    return { ok: true, status: 200 } as Response;
  });
  // installProcessHandlers off: a vitest worker that acquires an
  // uncaughtExceptionMonitor per test file would report the SUITE's own
  // deliberate throws.
  initErrorReporting({ service: "worker", release: "abc1234", installProcessHandlers: false });
});

afterEach(() => {
  resetErrorReporting();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseDsn", () => {
  it("builds the envelope endpoint from a DSN", () => {
    expect(parseDsn(DSN)).toEqual({
      endpoint: "https://errors.example.com/api/7/envelope/",
      publicKey: "abc123def456",
    });
  });

  it("works for a self-hosted GlitchTip on a port and a path", () => {
    expect(parseDsn("http://key@10.0.0.9:8000/2")?.endpoint).toBe(
      "http://10.0.0.9:8000/api/2/envelope/",
    );
  });

  it("returns null for anything malformed rather than throwing", () => {
    // A typo in an env var must disable reporting, not stop the service
    // booting - which is the same rule as `assert-env` inverted, and on purpose.
    for (const bad of ["", "   ", "not a url", "https://errors.example.com/7", "https://key@host"]) {
      expect(parseDsn(bad)).toBeNull();
    }
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn(null)).toBeNull();
  });
});

describe("no DSN is a no-op, not a failure", () => {
  it("reports disabled and sends nothing", () => {
    resetErrorReporting();
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("GLITCHTIP_DSN", "");
    expect(initErrorReporting({ service: "api", installProcessHandlers: false })).toBe(false);
    expect(errorReportingEnabled()).toBe(false);
    captureError(new Error("boom"));
    expect(sent).toEqual([]);
  });
});

describe("the scrubber", () => {
  it("removes a JWT whole, not in pieces", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const out = scrub(`auth failed for ${jwt}`);
    expect(out).toContain("[jwt]");
    expect(out).not.toContain("eyJ");
  });

  it("removes a presigned object-storage URL", () => {
    const url =
      "https://minio.internal/aura-recordings/org/call.m4a?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=900";
    const out = scrub(`could not fetch ${url}`);
    expect(out).toContain("[presigned-url]");
    expect(out).not.toContain("X-Amz-Signature");
    expect(out).not.toContain("call.m4a");
  });

  it("removes phone numbers in both shapes this product sees", () => {
    expect(scrub("no answer from +91 98765 43210")).not.toContain("98765");
    expect(scrub("lead 9876543210 rejected")).not.toContain("9876543210");
  });

  it("removes an email address", () => {
    expect(scrub("owner asha@example.co.in could not be notified")).not.toContain("asha@");
  });

  it("redacts a labelled secret but keeps the label, so the error still reads", () => {
    const out = scrub("request failed: api_key=sk-live-9f8e7d6c5b4a3210 rejected");
    expect(out).toContain("api_key=[redacted]");
    expect(out).not.toContain("sk-live");
  });

  it("leaves an ordinary message alone", () => {
    const msg = "sarvam job 20260901_job still unfinished after 41 minutes";
    expect(scrub(msg)).toBe(msg);
  });
});

describe("what the envelope contains", () => {
  it("sends the exception type, a scrubbed message and the tags", () => {
    captureError(new TypeError("cannot read properties of undefined"), {
      orgId: "00000000-0000-4000-8000-000000000001",
      callId: "11111111-1111-4111-8111-111111111111",
      where: "pipeline.asr",
    });

    const event = envelope() as {
      exception: { values: Array<{ type: string; value: string }> };
      tags: Record<string, string>;
      release: string;
      environment: string;
    };
    expect(event.exception.values[0]!.type).toBe("TypeError");
    expect(event.exception.values[0]!.value).toContain("cannot read properties");
    expect(event.tags).toEqual({
      service: "worker",
      environment: "production",
      org_id: "00000000-0000-4000-8000-000000000001",
      call_id: "11111111-1111-4111-8111-111111111111",
      where: "pipeline.asr",
    });
    expect(event.release).toBe("abc1234");
  });

  it("posts to the envelope endpoint with the auth header", () => {
    captureError(new Error("boom"));
    expect(sent[0]!.url).toBe("https://errors.example.com/api/7/envelope/");
    expect(sent[0]!.headers["x-sentry-auth"]).toContain("sentry_key=abc123def456");
  });

  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * A transcript reaches an error message the moment somebody writes
   * `new Error(\`could not parse ${text}\`)` to be helpful. The event is built
   * from an allowlist so there is no field for one to ride in, and the message
   * itself is scrubbed and truncated - but the test is on the WIRE BODY,
   * because that is the only thing a DPA cares about.
   */
  it("never puts call content on the wire", () => {
    const transcript =
      "S1: Hello sir, this is Rakesh from Fortune Innovatives calling about the flat in Adyar. " +
      "S2: Yes, my number is +91 98765 43210, please WhatsApp me the brochure at raj@example.com.";
    captureError(new Error(`analyze failed for transcript: ${transcript}`), {
      orgId: "00000000-0000-4000-8000-000000000001",
    });

    const body = wire();
    expect(body).not.toContain("98765");
    expect(body).not.toContain("raj@example.com");
    // And none of the fields an SDK would have attached exist at all.
    const event = envelope();
    expect(event.request).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.user).toBeUndefined();
  });

  it("drops a tag key that is not on the allowlist", () => {
    // @ts-expect-error - deliberately passing a key the type does not permit,
    // which is what a future caller doing the same by accident looks like.
    captureError(new Error("boom"), { orgId: "org", customerName: "Fortune Innovatives" });
    expect(wire()).not.toContain("Fortune");
  });

  it("refuses an org id that is not shaped like an id", () => {
    // A NAME passed where an id was expected is the likeliest way a tenant's
    // identity leaks, and it is a plausible mistake: both are strings.
    captureError(new Error("boom"), { orgId: "Fortune Innovatives" });
    const event = envelope() as { tags: Record<string, string> };
    expect(event.tags.org_id).toBeUndefined();
    expect(wire()).not.toContain("Fortune");
  });

  it("truncates a huge message rather than sending it", () => {
    captureError(new Error("x".repeat(50_000)));
    expect(wire().length).toBeLessThan(5_000);
  });
});

describe("stack frames", () => {
  it("keeps the repo-relative path and drops the machine's layout", () => {
    const frames = parseStack(
      [
        "Error: boom",
        "    at fail (C:\\Users\\someone\\Desktop\\work\\platform\\apps\\worker\\src\\pipeline\\pipeline.ts:240:12)",
        "    at /opt/aura/platform/packages/db/src/index.js:88:3",
        "    at node:internal/process/task_queues:104:5",
      ].join("\n"),
    );
    const names = frames.map((f) => f.filename);
    expect(names).toContain("apps/worker/src/pipeline/pipeline.ts");
    expect(names.join(" ")).not.toContain("Users");
    expect(names.join(" ")).not.toContain("someone");
    // Innermost last, which is how Sentry renders the crash site.
    expect(frames[frames.length - 1]!.filename).toContain("pipeline.ts");
    // node: internals are not ours.
    expect(frames.find((f) => f.filename.startsWith("node:"))?.in_app).toBe(false);
  });

  it("returns nothing for a missing stack rather than throwing", () => {
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe("a crash loop cannot become the incident", () => {
  it("collapses repeats of one error inside the dedupe window", () => {
    vi.stubEnv("ERROR_REPORT_DEDUPE_MS", String(5 * 60 * 1000));
    resetErrorReporting();
    initErrorReporting({ service: "worker", installProcessHandlers: false });

    for (let i = 0; i < 50; i++) captureError(new Error("the same thing"), { where: "sweep" });
    // The FIRST occurrence always goes - it is the one that matters.
    expect(sent.length).toBe(1);
  });

  it("caps the burst even when every error is different", () => {
    vi.stubEnv("ERROR_REPORT_MAX_PER_MINUTE", "5");
    resetErrorReporting();
    initErrorReporting({ service: "worker", installProcessHandlers: false });

    for (let i = 0; i < 50; i++) captureError(new Error(`distinct ${i}`));
    expect(sent.length).toBe(5);
  });
});

describe("the reporter never becomes the failure", () => {
  it("swallows a transport error", () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(() => captureError(new Error("boom"))).not.toThrow();
  });

  it("swallows a non-2xx from the ingest endpoint", () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 429 }) as Response);
    expect(() => captureError(new Error("boom"))).not.toThrow();
  });

  it("handles a thrown non-Error", () => {
    expect(() => captureError("just a string")).not.toThrow();
    expect(() => captureError(null)).not.toThrow();
    expect(() => captureError({ weird: true })).not.toThrow();
  });
});
