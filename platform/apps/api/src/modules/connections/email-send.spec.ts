import { buildMime, canSend, dailySendLimit, sendingEnabled } from "./email-send";

/**
 * These cases guard the one thing in this CRM that reaches a real person who
 * never asked to be in it. A wrong number on a report is embarrassing; a
 * message that goes out cannot be recalled, and the recipient does not care
 * that a flag was misread. So the defaults and the header handling are pinned
 * explicitly rather than left to be inferred from the happy path.
 */

describe("sendingEnabled - the master switch", () => {
  it("is OFF when nothing is set", () => {
    expect(sendingEnabled({})).toBe(false);
  });

  it("is ON only for the exact string 'true'", () => {
    expect(sendingEnabled({ EMAIL_SENDING_ENABLED: "true" })).toBe(true);
  });

  it("stays OFF for every near-miss", () => {
    // A deployment that meant to enable this and typed "1" gets a switched-off
    // system it will notice in seconds. The reverse mistake is an incident.
    for (const value of ["1", "yes", "TRUE", "True", "on", "", " true", "false"]) {
      expect([value, sendingEnabled({ EMAIL_SENDING_ENABLED: value })]).toEqual([value, false]);
    }
  });
});

describe("dailySendLimit", () => {
  it("defaults to a small number rather than unlimited", () => {
    expect(dailySendLimit({})).toBe(100);
  });

  it("takes a configured cap", () => {
    expect(dailySendLimit({ EMAIL_SEND_DAILY_LIMIT: "25" })).toBe(25);
  });

  it("falls back to the default for junk, zero and negatives", () => {
    // Notably NOT "0 means unlimited". Whatever somebody typed, the answer is
    // a finite cap.
    for (const value of ["0", "-5", "lots", "", "NaN"]) {
      expect([value, dailySendLimit({ EMAIL_SEND_DAILY_LIMIT: value })]).toEqual([value, 100]);
    }
  });
});

describe("canSend", () => {
  it("allows only the two providers with a tested send path", () => {
    expect(canSend("google")).toBe(true);
    expect(canSend("microsoft")).toBe(true);
  });

  it("refuses providers whose send path does not exist", () => {
    // `caldav` is a calendar and has no mail path at all; 'stub' must never be
    // a live sender; the empty string and a miscased name are the two ways a
    // caller reaches this with something that is not a provider.
    for (const provider of ["caldav", "stub", "", "GOOGLE"]) {
      expect([provider, canSend(provider)]).toEqual([provider, false]);
    }
  });

  it("allows imap now that there is an SMTP client behind it", () => {
    // It was excluded as a GAP, not a policy: the connection could read a
    // tenant's mail onto the timeline and could not reply from the console.
    // smtp.ts is the missing half - see its header.
    expect(canSend("imap")).toBe(true);
  });
});

describe("buildMime - header injection", () => {
  const base = {
    to: "priya@customer.com",
    subject: "Your quote",
    body: "Attached.",
    fromEmail: "rep@example.com",
  };

  it("builds a plain message", () => {
    const mime = buildMime(base);
    expect(mime).toContain("From: rep@example.com");
    expect(mime).toContain("To: priya@customer.com");
    expect(mime).toContain("Subject: Your quote");
    expect(mime).toContain("Attached.");
  });

  it("strips newlines from the subject - otherwise it is a Bcc field", () => {
    const attack = buildMime({
      ...base,
      subject: "Your quote\r\nBcc: everyone@competitor.example",
    });
    expect(attack).not.toContain("Bcc:\r\n");
    // The injected text survives as literal subject content, which is the
    // point: it is neutralised, not silently deleted.
    expect(attack).toContain("Subject: Your quote Bcc: everyone@competitor.example");
    // And there is exactly one recipient header.
    expect(attack.match(/^To:/gm)).toHaveLength(1);
  });

  it("strips newlines from the recipient and the display name too", () => {
    const mime = buildMime({
      ...base,
      to: "priya@customer.com\nBcc: other@example.com",
      fromName: "Rep\r\nX-Spoof: yes",
    });
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).not.toMatch(/^X-Spoof:/m);
  });

  it("leaves newlines in the BODY alone - only headers are the injection surface", () => {
    const mime = buildMime({ ...base, body: "Line one\nLine two\n\nRegards" });
    expect(mime).toContain("Line one\nLine two\n\nRegards");
  });

  it("puts a blank line between headers and body, as RFC 5322 requires", () => {
    const mime = buildMime(base);
    const [headers, body] = mime.split("\r\n\r\n");
    expect(headers).toContain("Content-Type: text/plain");
    expect(body).toBe("Attached.");
  });

  it("renders a display name when there is one", () => {
    expect(buildMime({ ...base, fromName: "Sam Rep" })).toContain(
      "From: Sam Rep <rep@example.com>",
    );
  });
});
