import { NotificationKind } from "@aura/shared";
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_ORDER,
  describeDelivery,
  notificationKindSpec,
} from "./notification-kinds";

describe("NOTIFICATION_KINDS", () => {
  it("labels every kind the shared enum knows, and nothing else", () => {
    expect(Object.keys(NOTIFICATION_KINDS).sort()).toEqual([...NotificationKind.options].sort());
    expect(NOTIFICATION_KIND_ORDER).toHaveLength(NotificationKind.options.length);
  });

  it("lists the kinds that need somebody to act first", () => {
    const flags = NOTIFICATION_KIND_ORDER.map((k) => NOTIFICATION_KINDS[k].needsAction);
    expect(flags.indexOf(false)).toBeGreaterThan(0);
    expect(flags.slice(flags.indexOf(false))).not.toContain(true);
    expect(NOTIFICATION_KINDS.sla_breach.needsAction).toBe(true);
    expect(NOTIFICATION_KINDS.review_pending.needsAction).toBe(true);
    expect(NOTIFICATION_KINDS.lead_assigned.needsAction).toBe(true);
  });

  it("falls back rather than throwing on a kind this console does not know", () => {
    expect(notificationKindSpec("from_the_future").label).toBe("Notification");
  });
});

describe("describeDelivery", () => {
  const now = new Date(2026, 8, 16, 15, 30);
  it("says today, tomorrow or how many days out", () => {
    expect(describeDelivery(new Date(2026, 8, 16, 17, 0).toISOString(), now)).toBe("at 17:00");
    expect(describeDelivery(new Date(2026, 8, 17, 9, 0).toISOString(), now)).toBe("tomorrow at 9:00");
    expect(describeDelivery(new Date(2026, 8, 19, 9, 5).toISOString(), now)).toBe("in 3 days at 9:05");
  });
});
