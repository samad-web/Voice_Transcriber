import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

/**
 * The endpoint over real HTTP, because the two things that matter about it are
 * both properties of the response and not of the class:
 *
 *  - it is on the open internet. Caddy and nginx both route the whole `/v1/*`
 *    prefix to this process, so "internal" is a statement of intent and the
 *    admin key is the only actual control. A guard that silently stopped being
 *    applied would leave a cross-tenant feed open, and no unit test of the
 *    guard in isolation would notice.
 *  - it must answer `text/event-stream`. That content type is what makes Caddy
 *    flush instead of buffer; get it wrong and every console goes quiet with
 *    a 200 in the access log.
 */

jest.mock("@aura/queue", () => ({
  publishEvent: jest.fn(),
  // Resolves without a broker: this suite is about the HTTP surface, and a
  // RabbitMQ dependency would make it an integration test nobody can run.
  consumeEvents: jest.fn(async () => undefined),
  closeEvents: jest.fn(async () => undefined),
}));

import { RealtimeModule } from "./realtime.module";

describe("GET /v1/internal/events", () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    const moduleRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("v1");
    await app.listen(0);
    url = `${await app.getUrl()}/v1/internal/events`.replace("[::1]", "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
  });

  /** Opens the stream, reads the headers, then hangs up. */
  async function open(headers: Record<string, string>) {
    const controller = new AbortController();
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      return { status: res.status, contentType: res.headers.get("content-type") };
    } finally {
      controller.abort();
    }
  }

  it("refuses a caller with no admin key", async () => {
    const res = await open({});
    expect(res.status).toBe(401);
  });

  it("refuses a wrong admin key", async () => {
    const res = await open({ "x-admin-key": "not-the-key" });
    expect(res.status).toBe(401);
  });

  it("streams to the web tier's credential", async () => {
    const res = await open({ "x-admin-key": "test-admin-key" });
    expect(res.status).toBe(200);
    // Load-bearing, not cosmetic: Caddy switches to unbuffered forwarding on
    // exactly this content type.
    expect(res.contentType).toContain("text/event-stream");
  });
});
