import { dotStuff, envelope, nextCommand, parseReply, SmtpError, type SmtpStep } from "./smtp";

/**
 * The SMTP dialogue.
 *
 * Tested as a pure state machine because that is where the protocol can go
 * wrong in ways nobody sees. Three failures in particular do not throw:
 *
 *   - Mis-parsing a multi-line EHLO puts every command one reply out of step
 *     for the rest of the session. The server's "334" prompt then arrives at
 *     the DATA step, and the mailbox password is transmitted as the message.
 *   - Missing dot-stuffing truncates any message quoting a line that starts
 *     with a full stop, and hands the remainder to the server as commands.
 *   - Continuing past an unexpected reply code sends the next thing anyway.
 *
 * No socket is opened here. The driver that owns the socket makes no decisions.
 */

const CONFIG = {
  host: "smtp.example.com",
  port: 587,
  user: "sales@example.com",
  password: "app-password",
  secure: false,
};

const MESSAGE = {
  from: "sales@example.com",
  to: "priya@customer.com",
  mime: "Subject: Hello\r\n\r\nBody text",
};

const step = (s: SmtpStep, code: number, lines: string[] = ["ok"]) =>
  nextCommand(s, { code, lines }, CONFIG, MESSAGE);

describe("parseReply", () => {
  it("waits for a complete reply rather than acting on half of one", () => {
    expect(parseReply("250-smtp.exam")).toBeNull();
    expect(parseReply("2")).toBeNull();
  });

  it("reads a single-line reply and leaves the rest in the buffer", () => {
    const out = parseReply("220 smtp.example.com ESMTP\r\n250 OK\r\n");
    expect(out?.reply).toEqual({ code: 220, lines: ["smtp.example.com ESMTP"] });
    expect(out?.rest).toBe("250 OK\r\n");
  });

  it("treats a hyphenated block as ONE reply, not several", () => {
    // The failure this prevents: three replies where there is one, and every
    // command afterwards answered by the reply to the previous one.
    const out = parseReply("250-smtp.example.com\r\n250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n");
    expect(out?.reply.code).toBe(250);
    expect(out?.reply.lines).toEqual(["smtp.example.com", "STARTTLS", "AUTH LOGIN PLAIN"]);
    expect(out?.rest).toBe("");
  });

  it("ignores a non-numeric code rather than reading it as NaN", () => {
    expect(parseReply("abc def\r\n")).toBeNull();
  });
});

describe("nextCommand - the happy path on port 587", () => {
  it("greets, upgrades, authenticates, then sends", () => {
    expect(step("greeting", 220)).toEqual({ send: "EHLO aura", next: "starttls" });
    expect(step("starttls", 250, ["smtp", "STARTTLS", "AUTH LOGIN"])).toEqual({
      send: "STARTTLS",
      next: "ehlo2",
    });
    expect(step("ehlo2", 220)).toEqual({ send: "EHLO aura", next: "auth" });
    expect(step("auth", 250, ["AUTH LOGIN"])).toEqual({ send: "AUTH LOGIN", next: "authUser" });

    const user = step("authUser", 334);
    expect(Buffer.from(user.send!, "base64").toString()).toBe("sales@example.com");
    const pass = step("authPass", 334);
    expect(Buffer.from(pass.send!, "base64").toString()).toBe("app-password");

    expect(step("mailFrom", 235)).toEqual({
      send: "MAIL FROM:<sales@example.com>",
      next: "rcptTo",
    });
    expect(step("rcptTo", 250)).toEqual({ send: "RCPT TO:<priya@customer.com>", next: "data" });
    expect(step("data", 250)).toEqual({ send: "DATA", next: "body" });
    expect(step("body", 354).next).toBe("quit");
    expect(step("quit", 250)).toEqual({ send: "QUIT", next: "done" });
  });

  it("skips STARTTLS when the connection is already encrypted", () => {
    const secure = { ...CONFIG, port: 465, secure: true };
    expect(nextCommand("greeting", { code: 220, lines: [] }, secure, MESSAGE)).toEqual({
      send: "EHLO aura",
      next: "auth",
    });
  });
});

describe("nextCommand - refusing to continue", () => {
  it("will not send the password to a server that does not offer STARTTLS", () => {
    // The whole point. A downgrade here puts a mailbox password on the wire,
    // and "the server did not support it" is not a reason to do that.
    expect(() => step("starttls", 250, ["smtp.example.com", "AUTH LOGIN"])).toThrow(
      /will not send your password unencrypted/,
    );
  });

  it("stops on every unexpected code rather than sending the next thing anyway", () => {
    expect(() => step("greeting", 554)).toThrow(SmtpError);
    expect(() => step("ehlo2", 500)).toThrow(/STARTTLS refused/);
    expect(() => step("authUser", 504)).toThrow(/refused AUTH LOGIN/);
    expect(() => step("rcptTo", 550)).toThrow(/sender refused/);
    expect(() => step("data", 550)).toThrow(/recipient refused/);
    expect(() => step("body", 451)).toThrow(/would not accept data/);
    expect(() => step("quit", 552)).toThrow(/was not accepted/);
  });

  it("says what a 535 actually means", () => {
    // It is a wrong password, and on almost every provider the fix is an app
    // password rather than the login one. "authentication failed" sends people
    // to support; this sends them to their account settings.
    expect(() => step("mailFrom", 535)).toThrow(/app password/);
  });
});

describe("dotStuff", () => {
  it("doubles a leading dot so the message cannot truncate itself", () => {
    // A single "." on its own line ENDS the message. Unstuffed, everything
    // after it is handed to the server as SMTP commands.
    expect(dotStuff("hello\n.\nworld")).toBe("hello\r\n..\r\nworld");
  });

  it("doubles a dot that merely starts a line", () => {
    expect(dotStuff(".gitignore is the file\nsecond line")).toBe(
      "..gitignore is the file\r\nsecond line",
    );
  });

  it("leaves a dot mid-line alone", () => {
    expect(dotStuff("see www.example.com today")).toBe("see www.example.com today");
  });

  it("normalises bare newlines to CRLF", () => {
    // SMTP is CRLF-only. A bare LF in the body is accepted by some servers and
    // silently mangles the message on others.
    expect(dotStuff("a\nb\r\nc")).toBe("a\r\nb\r\nc");
  });
});

describe("envelope", () => {
  it("strips the characters that would inject an SMTP command", () => {
    // The mail equivalent of header injection: a newline in an address ends
    // the MAIL FROM line and the rest is read as a command.
    expect(envelope("priya@x.com>\r\nRCPT TO:<attacker@evil.com")).toBe(
      "priya@x.comRCPT TO:attacker@evil.com",
    );
  });

  it("leaves an ordinary address untouched", () => {
    expect(envelope("  priya@customer.com ")).toBe("priya@customer.com");
  });
});
