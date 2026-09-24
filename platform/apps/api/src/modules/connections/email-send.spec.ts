import {
  buildMime,
  canSend,
  dailySendLimit,
  newMessageId,
  sendingEnabled,
  sendMessage,
} from "./email-send";

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

  it("writes a Message-ID header only when given one, and sanitises it like any header", () => {
    expect(buildMime(base)).not.toMatch(/^Message-ID:/m);
    const mime = buildMime({ ...base, messageId: "<abc@example.com>\r\nBcc: x@evil.example" });
    expect(mime).toMatch(/^Message-ID: <abc@example.com> Bcc: x@evil.example$/m);
    expect(mime).not.toMatch(/^Bcc:/m);
  });
});

describe("newMessageId", () => {
  it("is an RFC 5322 id in the sender's own domain", () => {
    expect(newMessageId("rep@example.com")).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
  });

  it("never repeats", () => {
    expect(newMessageId("rep@example.com")).not.toBe(newMessageId("rep@example.com"));
  });
});

/**
 * The Outlook send, which used to write every message twice onto the
 * timeline: `/me/sendMail` returns 202 with no body, so the console's row had
 * no key and the sync's copy of the Sent item could not be matched to it.
 */
describe("sendMessage - Microsoft Graph", () => {
  const message = {
    to: "priya@customer.com",
    subject: "Your quote",
    body: "Attached.",
    fromEmail: "rep@example.com",
  };

  function graph(
    responses: Array<{ status: number; body?: unknown }>,
  ): { fetchImpl: typeof fetch; calls: Array<{ url: string; method: string; body?: string }> } {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const queue = [...responses];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      const next = queue.shift() ?? { status: 500, body: { error: "unexpected call" } };
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
      });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("creates a draft, sends it, and returns the Message-ID Exchange assigned", async () => {
    const { fetchImpl, calls } = graph([
      { status: 201, body: { id: "AAMkDraft=", internetMessageId: "<draft-1@prod.outlook.com>" } },
      { status: 202 },
    ]);

    const result = await sendMessage("microsoft", "token", message, fetchImpl);

    expect(result).toEqual({ externalId: null, internetMessageId: "<draft-1@prod.outlook.com>" });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "https://graph.microsoft.com/v1.0/me/messages"],
      ["POST", "https://graph.microsoft.com/v1.0/me/messages/AAMkDraft%3D/send"],
    ]);
    // The recipient is exactly the one given, and nothing else rides along.
    const draft = JSON.parse(calls[0].body ?? "{}");
    expect(draft.toRecipients).toEqual([{ emailAddress: { address: "priya@customer.com" } }]);
    expect(draft.ccRecipients).toBeUndefined();
    expect(draft.bccRecipients).toBeUndefined();
  });

  it("never uses /sendMail, whose empty 202 is what left nothing to dedupe on", async () => {
    const { fetchImpl, calls } = graph([
      { status: 201, body: { id: "d", internetMessageId: "<x@y>" } },
      { status: 202 },
    ]);
    await sendMessage("microsoft", "token", message, fetchImpl);
    expect(calls.some((c) => c.url.includes("sendMail"))).toBe(false);
  });

  it("throws and removes the draft when the send itself is refused", async () => {
    const { fetchImpl, calls } = graph([
      { status: 201, body: { id: "d1", internetMessageId: "<x@y>" } },
      { status: 403, body: { error: "ErrorAccessDenied" } },
      { status: 204 },
    ]);
    await expect(sendMessage("microsoft", "token", message, fetchImpl)).rejects.toThrow(
      /refused the message \(403\)/,
    );
    expect(calls[2]).toMatchObject({
      method: "DELETE",
      url: "https://graph.microsoft.com/v1.0/me/messages/d1",
    });
  });

  it("sends nothing when the draft cannot be created", async () => {
    const { fetchImpl, calls } = graph([{ status: 400, body: { error: "bad" } }]);
    await expect(sendMessage("microsoft", "token", message, fetchImpl)).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });

  it("still reports the send when Exchange returned no Message-ID - no key, but no failure", async () => {
    const { fetchImpl } = graph([{ status: 201, body: { id: "d" } }, { status: 202 }]);
    await expect(sendMessage("microsoft", "token", message, fetchImpl)).resolves.toEqual({
      externalId: null,
      internetMessageId: null,
    });
  });
});

describe("sendMessage - Gmail", () => {
  it("returns Gmail's own id, which the sync reads back from Sent unchanged", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "18c0ffee" }), { status: 200 })) as typeof fetch;
    await expect(
      sendMessage(
        "google",
        "token",
        { to: "a@b.com", subject: "s", body: "b", fromEmail: "rep@example.com" },
        fetchImpl,
      ),
    ).resolves.toEqual({ externalId: "18c0ffee", internetMessageId: null });
  });
});
