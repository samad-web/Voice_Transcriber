import { describe, expect, it } from "vitest";
import {
  deviceUnderstandsAlertsSql,
  HANDSET_ALERTS_MIN_VERSION_CODE,
  HANDSET_ALERT_STYLE,
  HANDSET_ALERT_TTL_MINUTES,
  HandsetAlertAckInput,
  HandsetAlertKind,
  handsetAlertDelivery,
  leadAlertBody,
  nextPushDelaySeconds,
  SendHandsetMessageInput,
} from "./handset-alerts";

const T = "11111111-1111-4111-8111-111111111111";

describe("handset alert styles", () => {
  it("pops up only what cannot wait", () => {
    const popups = HandsetAlertKind.options.filter((k) => HANDSET_ALERT_STYLE[k] === "popup");
    expect(popups.sort()).toEqual(["lead_assigned", "manager_message"]);
  });

  it("gives every kind a lifetime", () => {
    for (const k of HandsetAlertKind.options) expect(HANDSET_ALERT_TTL_MINUTES[k]).toBeGreaterThan(0);
  });
});

describe("nextPushDelaySeconds", () => {
  it("retries fast first, then backs off and holds", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 11].map(nextPushDelaySeconds)).toEqual([0, 60, 120, 300, 600, 900, 1800, 1800]);
  });
});

describe("SendHandsetMessageInput", () => {
  it("needs a recipient", () => {
    const r = SendHandsetMessageInput.safeParse({ body: "Team meeting at 4" });
    expect(r.success).toBe(false);
  });

  it("accepts everyone, and pops up by default", () => {
    const r = SendHandsetMessageInput.parse({ everyone: true, body: "  Team meeting at 4 " });
    expect(r).toMatchObject({ everyone: true, telecallerIds: [], body: "Team meeting at 4", popup: true });
  });

  it("accepts named telecallers and an explicit banner", () => {
    const r = SendHandsetMessageInput.parse({ telecallerIds: [T], body: "Call Ravi", popup: false });
    expect(r.popup).toBe(false);
  });

  it("refuses an empty message and an over-long one", () => {
    expect(SendHandsetMessageInput.safeParse({ everyone: true, body: "   " }).success).toBe(false);
    expect(SendHandsetMessageInput.safeParse({ everyone: true, body: "x".repeat(501) }).success).toBe(false);
  });
});

describe("HandsetAlertAckInput", () => {
  it("defaults both lists", () => {
    expect(HandsetAlertAckInput.parse({})).toEqual({ delivered: [], opened: [] });
  });

  it("refuses ids that are not uuids", () => {
    expect(HandsetAlertAckInput.safeParse({ delivered: ["1"] }).success).toBe(false);
  });
});

describe("handsetAlertDelivery", () => {
  const now = Date.parse("2026-10-01T10:00:00Z");
  const base = { deliveredAt: null, openedAt: null, expiresAt: "2026-10-01T12:00:00Z", hasPhone: true };

  it("read beats delivered", () => {
    expect(
      handsetAlertDelivery({ ...base, deliveredAt: "2026-10-01T09:00:00Z", openedAt: "2026-10-01T09:01:00Z" }, now),
    ).toBe("read");
    expect(handsetAlertDelivery({ ...base, deliveredAt: "2026-10-01T09:00:00Z" }, now)).toBe("delivered");
  });

  it("is still sending inside its lifetime, and not reached after it", () => {
    expect(handsetAlertDelivery(base, now)).toBe("sending");
    expect(handsetAlertDelivery({ ...base, expiresAt: "2026-10-01T09:59:59Z" }, now)).toBe("not_reached");
  });

  it("says so when there is no phone to collect it", () => {
    expect(handsetAlertDelivery({ ...base, hasPhone: false }, now)).toBe("no_phone");
  });

  it("a delivered alert stays delivered even if its phone was later removed", () => {
    expect(handsetAlertDelivery({ ...base, hasPhone: false, deliveredAt: "2026-10-01T09:00:00Z" }, now)).toBe(
      "delivered",
    );
  });
});

describe("deviceUnderstandsAlertsSql", () => {
  it("guards the cast and treats an unknown version as able", () => {
    const sql = deviceUnderstandsAlertsSql("d");
    expect(sql).toContain("CASE WHEN d.app_version ~ '^[0-9]{1,9}$' THEN d.app_version::int END");
    expect(sql).toContain(`COALESCE(`);
    expect(sql).toContain(`, ${HANDSET_ALERTS_MIN_VERSION_CODE}) >= ${HANDSET_ALERTS_MIN_VERSION_CODE}`);
  });
});

describe("leadAlertBody", () => {
  it("names the source when it is known", () => {
    expect(leadAlertBody("Ravi Kumar", "meta_ads")).toBe("Ravi Kumar · from a Meta ad");
  });

  it("is just the title otherwise", () => {
    expect(leadAlertBody("+91 98•••321", null)).toBe("+91 98•••321");
    expect(leadAlertBody("Ravi", "something_new")).toBe("Ravi");
  });
});
