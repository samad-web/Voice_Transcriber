import { describe, expect, it } from "vitest";
import {
  extractPhoneFromText,
  intakeEndpointPath,
  intakeProvider,
  intakeRejectionReason,
  isBlockedSender,
  isInboundCall,
  isOriginAllowed,
  LEAD_INTAKE_CHANNELS,
  LeadSourceChannel,
  normalizeIntake,
  parseEmailSender,
  pickField,
  pickPath,
  resolveFieldMap,
} from "./lead-intake";

describe("pickPath", () => {
  it("reads dotted paths and array indices", () => {
    const payload = { mail: { commonHeaders: { from: ["a@b.com", "c@d.com"], subject: "Hi" } } };
    expect(pickPath(payload, "mail.commonHeaders.from[0]")).toBe("a@b.com");
    expect(pickPath(payload, "mail.commonHeaders.subject")).toBe("Hi");
  });

  it("returns null for a path landing on an object or array", () => {
    // The bug this prevents: "[object Object]" arriving as somebody's name.
    expect(pickPath({ a: { b: 1 } }, "a")).toBeNull();
    expect(pickPath({ a: [1, 2] }, "a")).toBeNull();
  });

  it("returns null for missing paths rather than throwing", () => {
    expect(pickPath({}, "a.b.c[3].d")).toBeNull();
    expect(pickPath(null, "a")).toBeNull();
  });

  it("stringifies numbers and booleans but not empty strings", () => {
    expect(pickPath({ n: 42 }, "n")).toBe("42");
    expect(pickPath({ b: false }, "b")).toBe("false");
    expect(pickPath({ s: "   " }, "s")).toBeNull();
  });
});

describe("pickField", () => {
  it("takes the first non-empty candidate in order", () => {
    expect(pickField({ name: "", full_name: "Priya" }, ["name", "full_name"])).toBe("Priya");
  });

  it("falls back to a case-insensitive top-level match", () => {
    // Form encoders disagree about case far more often than about nesting.
    expect(pickField({ Phone: "9876543210" }, ["phone"])).toBe("9876543210");
  });

  it("does not case-fold nested paths", () => {
    expect(pickField({ Data: { Name: "x" } }, ["data.name"])).toBeNull();
  });
});

describe("resolveFieldMap", () => {
  it("puts tenant overrides before the preset, keeping both", () => {
    const map = resolveFieldMap("web_form", "generic", { phone: ["mob_no"] });
    expect(map.phone?.[0]).toBe("mob_no");
    expect(map.phone).toContain("phone");
    // Overriding one field must not lose the others.
    expect(map.email).toContain("email");
  });

  it("falls back to the generic provider for an unknown one", () => {
    expect(resolveFieldMap("telephony", "not-a-vendor").phone).toContain("from");
  });
});

describe("normalizeIntake - web form", () => {
  it("reads a plain HTML form", () => {
    const out = normalizeIntake("web_form", "generic", {
      name: "Priya Sharma",
      email: "PRIYA@acme.com",
      phone: "+91 98765 43210",
      message: "Need 200 units by March",
      budget: "₹250000",
      utm_source: "google",
      utm_campaign: "brand-mar",
    });
    expect(out.name).toBe("Priya Sharma");
    expect(out.email).toBe("priya@acme.com");
    expect(out.phone).toBe("+91 98765 43210");
    expect(out.notes).toBe("Need 200 units by March");
    expect(out.value).toBe(250000);
    expect(out.utm.source).toBe("google");
    expect(out.utm.campaign).toBe("brand-mar");
  });

  it("reads Contact Form 7's default field names", () => {
    // The single most common form builder on the web; without these aliases
    // every CF7 submission arrives anonymous.
    const out = normalizeIntake("web_form", "generic", {
      "your-name": "Ravi",
      "your-email": "ravi@example.com",
      "your-message": "Please call",
    });
    expect(out.name).toBe("Ravi");
    expect(out.email).toBe("ravi@example.com");
    expect(out.notes).toBe("Please call");
  });

  it("keeps unmapped scalars as facts but drops secrets and bulk", () => {
    const out = normalizeIntake("web_form", "generic", {
      name: "A",
      city: "Chennai",
      token: "sekrit",
      html: "<p>...</p>",
      nested: { a: 1 },
    });
    expect(out.facts.city).toBe("Chennai");
    expect(out.facts.token).toBeUndefined();
    expect(out.facts.html).toBeUndefined();
    expect(out.facts.nested).toBeUndefined();
  });

  it("rejects a value that is not a number", () => {
    expect(normalizeIntake("web_form", "generic", { name: "A", budget: "lots" }).value).toBeNull();
  });
});

describe("normalizeIntake - email", () => {
  it("splits a From header and digs the phone out of the body", () => {
    const out = normalizeIntake("email", "postmark", {
      MessageID: "abc-123",
      FromFull: { Email: "Ravi@Example.com", Name: "Ravi Kumar" },
      Subject: "Quote request",
      TextBody: "Hello, please send a quote. You can reach me on +91 90000 11111.",
    });
    expect(out.externalId).toBe("abc-123");
    expect(out.email).toBe("ravi@example.com");
    expect(out.name).toBe("Ravi Kumar");
    expect(out.phone).toBe("+91 90000 11111");
    // Subject and body both survive - the subject is what a person recognises
    // the lead by, the body is where the number was.
    expect(out.notes).toContain("Quote request");
    expect(out.notes).toContain("please send a quote");
  });

  it("parses an angle-bracket From when the relay sends the whole header", () => {
    const out = normalizeIntake("email", "mailgun", {
      sender: "Priya Sharma <priya@acme.com>",
      subject: "Enquiry",
      "stripped-text": "Interested in the 3D website package.",
    });
    expect(out.email).toBe("priya@acme.com");
    expect(out.name).toBe("Priya Sharma");
  });

  it("falls back to the local part when there is no display name", () => {
    const out = normalizeIntake("email", "generic", { from: "sales.lead@acme.com", text: "hi" });
    expect(out.name).toBe("sales.lead");
  });

  it("reads an SES/SNS notification through its nested paths", () => {
    const out = normalizeIntake("email", "ses", {
      mail: {
        messageId: "ses-1",
        commonHeaders: { from: ["Ops <ops@acme.com>"], subject: "New enquiry" },
        destination: ["intake@aura.example"],
      },
      content: "Call me on 0442 555 6677",
    });
    expect(out.externalId).toBe("ses-1");
    expect(out.email).toBe("ops@acme.com");
    expect(out.notes).toContain("New enquiry");
  });
});

describe("normalizeIntake - telephony", () => {
  it("reads an Exotel passthrough", () => {
    const out = normalizeIntake("telephony", "exotel", {
      CallSid: "abc123",
      From: "09876543210",
      To: "08041234567",
      Direction: "incoming",
      DialCallStatus: "no-answer",
      StartTime: "2026-09-01 10:00:00",
    });
    expect(out.externalId).toBe("abc123");
    expect(out.phone).toBe("09876543210");
    expect(out.notes).toBe("no-answer");
    expect(out.occurredAt).toBe("2026-09-01 10:00:00");
  });

  it("reads Knowlarity and Ozonetel's very different field names", () => {
    const knowlarity = normalizeIntake("telephony", "knowlarity", {
      uuid: "k-1",
      caller_id: "+919000000000",
      call_type: "incoming",
      call_status: "missed",
    });
    expect(knowlarity.externalId).toBe("k-1");
    expect(knowlarity.phone).toBe("+919000000000");

    const ozonetel = normalizeIntake("telephony", "ozonetel", {
      ucid: "o-1",
      cid: "919000000001",
      did: "918040000000",
      call_type: "inbound",
    });
    expect(ozonetel.externalId).toBe("o-1");
    expect(ozonetel.phone).toBe("919000000001");
  });

  it("leaves the name null so the ingest service can fall back to the number", () => {
    expect(normalizeIntake("telephony", "generic", { from: "9000000000" }).name).toBeNull();
  });
});

describe("isInboundCall", () => {
  it("accepts the inbound spellings each vendor uses", () => {
    expect(isInboundCall("inbound", "generic")).toBe(true);
    expect(isInboundCall("incoming", "exotel")).toBe(true);
    expect(isInboundCall("missed", "knowlarity")).toBe(true);
    expect(isInboundCall("call-attempt", "exotel")).toBe(true);
  });

  it("rejects outbound, including spellings that CONTAIN an inbound word", () => {
    // "outgoing" contains "in". A containment test here would classify every
    // outbound call as a new lead and fill the board with the rep's own work.
    expect(isInboundCall("outgoing", "generic")).toBe(false);
    expect(isInboundCall("outbound-dial", "exotel")).toBe(false);
    expect(isInboundCall("outbound-api", "exotel")).toBe(false);
    // Ozonetel calls an agent-initiated dial "manual".
    expect(isInboundCall("manual", "ozonetel")).toBe(false);
  });

  it("treats an unknown or absent direction as inbound", () => {
    // A missed enquiry is invisible; a spurious card is deleted in two seconds.
    expect(isInboundCall(null, "generic")).toBe(true);
    expect(isInboundCall("weird-vendor-value", "generic")).toBe(true);
  });
});

describe("guards", () => {
  it("blocks a sender by address or by domain", () => {
    expect(isBlockedSender("bot@acme.com", ["bot@acme.com"])).toBe(true);
    expect(isBlockedSender("anyone@spam.io", ["@spam.io"])).toBe(true);
    expect(isBlockedSender("real@acme.com", ["@spam.io"])).toBe(false);
    expect(isBlockedSender(null, ["@spam.io"])).toBe(false);
  });

  it("allows any origin when unset, and matches wildcards", () => {
    expect(isOriginAllowed("https://acme.com", undefined)).toBe(true);
    expect(isOriginAllowed("https://acme.com", ["*"])).toBe(true);
    expect(isOriginAllowed("https://acme.com", ["https://acme.com"])).toBe(true);
    expect(isOriginAllowed("https://www.acme.com", ["*.acme.com"])).toBe(true);
    expect(isOriginAllowed("https://evil.com", ["*.acme.com"])).toBe(false);
  });

  it("allows a request with no Origin at all", () => {
    // Server-to-server posts and curl send none; refusing them would break
    // every integration that is not a browser.
    expect(isOriginAllowed(null, ["https://acme.com"])).toBe(true);
  });

  it("does not match a domain that merely ends with the wildcard suffix", () => {
    expect(isOriginAllowed("https://notacme.com", ["*.acme.com"])).toBe(false);
  });
});

describe("extractPhoneFromText", () => {
  it("finds a real number", () => {
    expect(extractPhoneFromText("ring me on +91 98765 43210 thanks")).toBe("+91 98765 43210");
  });

  it("ignores short numbers, years and prices", () => {
    expect(extractPhoneFromText("we need 200 units by 2026")).toBeNull();
    expect(extractPhoneFromText("budget is 50000")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractPhoneFromText(null)).toBeNull();
    expect(extractPhoneFromText("")).toBeNull();
  });
});

describe("parseEmailSender", () => {
  it("handles the three shapes a From header arrives in", () => {
    expect(parseEmailSender("Priya <p@a.com>")).toEqual({ name: "Priya", email: "p@a.com" });
    expect(parseEmailSender("p@a.com")).toEqual({ name: null, email: "p@a.com" });
    expect(parseEmailSender('"Sharma, Priya" <p@a.com>').email).toBe("p@a.com");
    expect(parseEmailSender(null)).toEqual({ name: null, email: null });
  });
});

describe("intakeRejectionReason", () => {
  const base = normalizeIntake("web_form", "generic", { name: "A" });

  it("accepts anything with a way to reach the person", () => {
    expect(intakeRejectionReason(base)).toBeNull();
    expect(intakeRejectionReason(normalizeIntake("web_form", "generic", { phone: "9000000000" }))).toBeNull();
    expect(intakeRejectionReason(normalizeIntake("web_form", "generic", { email: "a@b.com" }))).toBeNull();
  });

  it("rejects a payload nothing could be read from, and says why", () => {
    const reason = intakeRejectionReason(normalizeIntake("web_form", "generic", { colour: "blue" }));
    expect(reason).toContain("field mapping");
  });
});

describe("catalogue", () => {
  it("gives every channel a unique id and at least one provider", () => {
    const ids = LEAD_INTAKE_CHANNELS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const channel of LEAD_INTAKE_CHANNELS) {
      expect(channel.providers.length).toBeGreaterThan(0);
      const providerIds = channel.providers.map((p) => p.id);
      expect(new Set(providerIds).size).toBe(providerIds.length);
    }
  });

  it("covers the four channels the engine exists for", () => {
    for (const kind of ["web_form", "email", "telephony", "meta_ads", "linkedin_ads"] as const) {
      expect(LEAD_INTAKE_CHANNELS.some((c) => c.id === kind)).toBe(true);
    }
  });

  it("only declares a signature scheme it names a header for", () => {
    for (const channel of LEAD_INTAKE_CHANNELS) {
      for (const provider of channel.providers) {
        if (provider.signature === "twilio" || provider.signature === "hmac_sha256_body") {
          expect(provider.signatureHeader).toBeTruthy();
        }
      }
    }
  });

  it("builds an endpoint path only for channels with an endpoint", () => {
    expect(intakeEndpointPath("web_form", "tok")).toBe("/intake/form/tok");
    expect(intakeEndpointPath("telephony", "tok")).toBe("/intake/telephony/tok");
    // LinkedIn is polled - there is nothing to receive, so there is no URL to
    // show a tenant, and offering one would be a lie they would try to use.
    expect(intakeEndpointPath("linkedin_ads", "tok")).toBeNull();
  });

  it("names Twilio's signature header", () => {
    expect(intakeProvider("telephony", "twilio")?.signatureHeader).toBe("x-twilio-signature");
  });

  it("keeps source_channel a superset of the configurable kinds", () => {
    // The CHECK in migration 0078 must accept everything a source can be, plus
    // the three channels that arrive without a lead_sources row.
    for (const channel of LEAD_INTAKE_CHANNELS) {
      expect(LeadSourceChannel.safeParse(channel.id).success).toBe(true);
    }
    for (const extra of ["call", "import", "manual"]) {
      expect(LeadSourceChannel.safeParse(extra).success).toBe(true);
    }
  });
});
