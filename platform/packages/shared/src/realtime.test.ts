import { describe, expect, it } from "vitest";
import { actionForMethod, topicForApiPath } from "./realtime";

describe("topicForApiPath", () => {
  it("takes the entity from the route, singularised", () => {
    expect(topicForApiPath("/v1/leads")).toBe("lead");
    expect(topicForApiPath("/v1/accounts/abc-123")).toBe("account");
    expect(topicForApiPath("/v1/quotations/1/send")).toBe("quotation");
  });

  it("sees through the console area prefixes", () => {
    // The same subject, whichever audience's route reached it.
    expect(topicForApiPath("/v1/owner/calls/abc")).toBe("call");
    expect(topicForApiPath("/v1/admin/leads")).toBe("lead");
    expect(topicForApiPath("/v1/public/contacts")).toBe("contact");
  });

  it("keeps a bare area prefix as its own subject", () => {
    // `/v1/owner` is a real controller; stripping "owner" here would leave
    // nothing and the mutation would go out untopiced.
    expect(topicForApiPath("/v1/owner")).toBe("owner");
  });

  it("routes intake to the lead board somebody is actually watching", () => {
    expect(topicForApiPath("/v1/intake/form/tok")).toBe("lead");
    expect(topicForApiPath("/v1/meta/webhook")).toBe("lead");
    // The distribution backfill moves leads in bulk, so it wakes the board.
    expect(topicForApiPath("/v1/owner/lead-routing/backfill")).toBe("lead");
  });

  it("does not wake every board when somebody merely edits a routing rule", () => {
    // The alias is keyed on the two-segment backfill path for exactly this
    // reason: renaming a rule changes no lead, and a console that re-fetched
    // every board on every settings keystroke is how a push channel becomes
    // something people switch off.
    expect(topicForApiPath("/v1/owner/lead-routing")).not.toBe("lead");
    expect(topicForApiPath("/v1/owner/lead-routing/rules")).not.toBe("lead");
  });

  it("prefers the two-segment alias over the one-segment one", () => {
    expect(topicForApiPath("/v1/messaging/webhook")).toBe("message");
    expect(topicForApiPath("/v1/messaging/channels")).toBe("connection");
  });

  it("stays silent for the handset fleet and for session churn", () => {
    // These fire constantly and change nothing anybody is looking at.
    expect(topicForApiPath("/v1/app/update")).toBeNull();
    expect(topicForApiPath("/v1/auth/login")).toBeNull();
    expect(topicForApiPath("/v1/devices/me/heartbeat")).toBeNull();
    // ...but a device route that is NOT the handset's own is still a change.
    expect(topicForApiPath("/v1/devices/abc/wipe")).toBe("device");
  });

  it("tolerates the shapes an interceptor actually sees", () => {
    expect(topicForApiPath("leads")).toBe("lead");
    expect(topicForApiPath("/v1/leads/")).toBe("lead");
    expect(topicForApiPath("/v1/leads?days=30")).toBe("lead");
    expect(topicForApiPath("/")).toBeNull();
    expect(topicForApiPath("")).toBeNull();
  });
});

describe("actionForMethod", () => {
  it("maps the verbs coarsely", () => {
    expect(actionForMethod("POST")).toBe("created");
    expect(actionForMethod("patch")).toBe("updated");
    expect(actionForMethod("PUT")).toBe("updated");
    expect(actionForMethod("DELETE")).toBe("deleted");
    expect(actionForMethod("GET")).toBe("changed");
  });
});
