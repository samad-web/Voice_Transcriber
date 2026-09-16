import { of, throwError } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { RealtimeEvent } from "@aura/shared";

/**
 * `@aura/queue` dials RabbitMQ the moment it is asked for a channel, so it is
 * mocked wholesale here. What is under test is the decision layer above it -
 * what gets published, for which tenant, and how much of a burst survives -
 * none of which needs a broker to be true.
 */
const published: unknown[] = [];
jest.mock("@aura/queue", () => ({
  publishEvent: (event: unknown) => {
    published.push(event);
  },
  consumeEvents: jest.fn(async () => undefined),
  closeEvents: jest.fn(async () => undefined),
}));

import { RealtimeInterceptor } from "./realtime.interceptor";
import { RealtimeService, realtimeDisabled } from "./realtime.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const RECORD = "33333333-3333-4333-8333-333333333333";

function event(over: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return { orgId: ORG, topic: "lead", action: "created", at: new Date().toISOString(), ...over };
}

beforeEach(() => {
  published.length = 0;
});

describe("RealtimeService", () => {
  it("publishes the first signal for a key immediately", () => {
    const service = new RealtimeService();
    service.publish(event());
    expect(published).toHaveLength(1);
  });

  it("folds a burst on the same key into one leading and one trailing send", async () => {
    jest.useFakeTimers();
    try {
      const service = new RealtimeService();
      // A CSV import: one signal per row. Un-coalesced this is a thousand
      // re-renders in every open console in the tenant.
      for (let i = 0; i < 1_000; i += 1) service.publish(event({ topic: "contact", id: RECORD }));
      expect(published).toHaveLength(1);

      jest.advanceTimersByTime(1_000);
      // The trailing send is not optional: without it the LAST change of a
      // burst is the one nobody hears about, and the console stays wrong.
      expect(published).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("coalesces per org and per topic, never across them", () => {
    const service = new RealtimeService();
    service.publish(event({ topic: "lead" }));
    service.publish(event({ topic: "call" }));
    service.publish(event({ topic: "lead", orgId: OTHER_ORG }));
    // One tenant's noisy import must not silence another tenant's arrival.
    expect(published).toHaveLength(3);
  });

  it("drops an event with no org rather than broadcasting it", () => {
    const service = new RealtimeService();
    service.publish(event({ orgId: "" }));
    expect(published).toHaveLength(0);
  });

  it("publishes nothing at all when the kill switch is set", () => {
    process.env.REALTIME_DISABLED = "1";
    try {
      const service = new RealtimeService();
      service.publish(event());
      expect(published).toHaveLength(0);
    } finally {
      delete process.env.REALTIME_DISABLED;
    }
  });

  it("reads the kill switch the way an operator would set it", () => {
    expect(realtimeDisabled({ REALTIME_DISABLED: "1" })).toBe(true);
    expect(realtimeDisabled({ REALTIME_DISABLED: "true" })).toBe(true);
    expect(realtimeDisabled({ REALTIME_DISABLED: "0" })).toBe(false);
    expect(realtimeDisabled({})).toBe(false);
  });
});

/** A minimal ExecutionContext - the interceptor only ever reads the request. */
function ctx(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const okHandler: CallHandler = { handle: () => of({ ok: true }) };

describe("RealtimeInterceptor", () => {
  const run = (req: Record<string, unknown>, handler: CallHandler = okHandler) => {
    const service = new RealtimeService();
    // Resolves on error too: a failed handler is a case under test, not a
    // failed test.
    return new Promise<void>((resolve) => {
      new RealtimeInterceptor(service)
        .intercept(ctx(req), handler)
        .subscribe({ complete: resolve, error: () => resolve(), next: () => undefined });
    });
  };

  it("announces a successful mutation with the topic its route implies", async () => {
    await run({ method: "POST", path: "/v1/leads", tenantOrgId: ORG, params: {} });
    expect(published).toEqual([
      expect.objectContaining({ orgId: ORG, topic: "lead", action: "created" }),
    ]);
  });

  it("says nothing about a read", async () => {
    await run({ method: "GET", path: "/v1/leads", tenantOrgId: ORG, params: {} });
    expect(published).toHaveLength(0);
  });

  it("says nothing when the handler failed", async () => {
    // A console re-reading because somebody's invalid form was rejected is
    // pure noise, and `tap`'s next handler is what keeps that from happening.
    const failing: CallHandler = { handle: () => throwError(() => new Error("bad request")) };
    await run({ method: "POST", path: "/v1/leads", tenantOrgId: ORG, params: {} }, failing);
    expect(published).toHaveLength(0);
  });

  it("refuses to guess a tenant it was never given", async () => {
    // The important negative. An unauthenticated webhook resolves its org
    // internally; announcing one from an unvalidated header would be how a
    // signal reaches the wrong customer.
    await run({
      method: "POST",
      path: "/v1/intake/form/tok",
      headers: { "x-org-id": ORG },
      params: {},
    });
    expect(published).toHaveLength(0);
  });

  it("takes the org from the API key on a headless integration route", async () => {
    await run({ method: "POST", path: "/v1/public/contacts", apiKey: { orgId: ORG }, params: {} });
    expect(published).toEqual([expect.objectContaining({ orgId: ORG, topic: "contact" })]);
  });

  it("carries the record id only when it is really a uuid", async () => {
    await run({
      method: "PATCH",
      path: "/v1/deals/abc",
      tenantOrgId: ORG,
      params: { id: "not-a-uuid" },
    });
    expect(published).toEqual([expect.objectContaining({ topic: "deal", id: null })]);

    published.length = 0;
    await run({ method: "PATCH", path: "/v1/deals/x", tenantOrgId: ORG, params: { id: RECORD } });
    expect(published).toEqual([expect.objectContaining({ topic: "deal", id: RECORD })]);
  });

  it("announces a handset's upload from its verified device token", async () => {
    // The product's primary input. A recording finishing its upload is the
    // moment a call appears in somebody's log, and DeviceAuthGuard writes
    // neither `principal` nor `tenantOrgId` - so without this the one thing
    // customers actually watch for would arrive unannounced.
    await run({
      method: "POST",
      path: "/v1/calls/abc/complete",
      device: { orgId: ORG, deviceId: "d1" },
      params: {},
    });
    expect(published).toEqual([expect.objectContaining({ orgId: ORG, topic: "call" })]);
  });

  it("stays silent on the routes the handset fleet hammers", async () => {
    await run({ method: "POST", path: "/v1/app/update-check", tenantOrgId: ORG, params: {} });
    await run({ method: "POST", path: "/v1/auth/login", tenantOrgId: ORG, params: {} });
    expect(published).toHaveLength(0);
  });
});
