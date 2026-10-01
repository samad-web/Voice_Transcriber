import { describe, expect, it } from "vitest";
import { inviteMessage, operatorInviteMessage, ownerInviteMessage } from "./invite-text";

/**
 * The failure this text exists to prevent: an invite is bound to one address,
 * the link gets forwarded on its own, and the recipient signs in with whatever
 * Google account their browser already held.
 */
describe("inviteMessage", () => {
  const link = "https://aura.sirahagents.com/invite/abc123";

  it("carries the address the invite is bound to", () => {
    const text = inviteMessage({ email: "jane@acme.com", link });
    expect(text).toContain("jane@acme.com");
    expect(text).toContain(link);
  });

  it("says the link will not work for another address", () => {
    expect(inviteMessage({ email: "jane@acme.com", link })).toMatch(/only works for that address/i);
  });

  it("names the workspace when there is one, and copes when there is not", () => {
    expect(inviteMessage({ email: "a@b.com", link, workspace: "Sirah Digital" })).toContain(
      "Sirah Digital on Aura",
    );
    expect(inviteMessage({ email: "a@b.com", link, workspace: null })).toContain("invited to Aura");
    // Whitespace is not a workspace name.
    expect(inviteMessage({ email: "a@b.com", link, workspace: "   " })).toContain("invited to Aura");
  });

  it("stays plain text, because it is pasted into a chat", () => {
    const text = inviteMessage({ email: "a@b.com", link });
    // WhatsApp does not render markdown - asterisks would arrive literally.
    expect(text).not.toMatch(/[*_`]/);
  });

  it("ends with the link, so it is the easiest thing to tap", () => {
    expect(inviteMessage({ email: "a@b.com", link }).trimEnd().endsWith(link)).toBe(true);
  });
});

/**
 * The superadmin variant (0145, doc 34 Part C). Same failure it guards against,
 * plus one more: this link grants administrative access across every customer,
 * and the person reading the message should be able to tell that from the
 * message rather than from the page it opens.
 */
describe("operatorInviteMessage", () => {
  const link = "https://aura.sirahagents.com/admin/invite/abc123";

  it("carries the address the invite is bound to", () => {
    const text = operatorInviteMessage({ email: "asha@sirah.in", link });
    expect(text).toContain("asha@sirah.in");
    expect(text).toContain(link);
    expect(text).toMatch(/only works for that address/i);
  });

  it("says what is being granted, and that it is not one workspace", () => {
    const text = operatorInviteMessage({ email: "a@b.com", link });
    expect(text).toMatch(/superadmin/i);
    expect(text).toMatch(/every customer workspace/i);
  });

  it("says the link is single-use", () => {
    expect(operatorInviteMessage({ email: "a@b.com", link })).toMatch(/used once/i);
  });

  it("never describes platform access as joining a workspace", () => {
    // The whole reason this is not `inviteMessage` with an optional workspace:
    // that one opens "You have been invited to Aura", which reads as a seat in
    // one tenant.
    const text = operatorInviteMessage({ email: "a@b.com", link });
    expect(text).not.toMatch(/^You have been invited to Aura\.$/m);
  });

  it("stays plain text and ends with the link", () => {
    const text = operatorInviteMessage({ email: "a@b.com", link });
    expect(text).not.toMatch(/[*_`]/);
    expect(text.trimEnd().endsWith(link)).toBe(true);
  });

  it("states the expiry in UTC, matching the emailed version", () => {
    // Composed in the SENDER's browser, so a local format would state their
    // timezone as though it were the recipient's. 23:30 UTC on the 2nd is still
    // the 2nd here, which it would not be in +05:30.
    const text = operatorInviteMessage({
      email: "a@b.com",
      link,
      expiresAt: "2026-10-02T23:30:00Z",
    });
    expect(text).toContain("2 Oct 2026");
    expect(text).toContain("(UTC)");
  });

  it("leaves the expiry out rather than guessing it", () => {
    for (const bad of [undefined, null, "", "not-a-date"]) {
      const text = operatorInviteMessage({ email: "a@b.com", link, expiresAt: bad });
      expect([String(bad), /expires/i.test(text)]).toEqual([String(bad), false]);
      expect(text).not.toContain("Invalid Date");
    }
  });
});

/**
 * The owner invite an operator issues from the instance page. It copied a bare
 * URL until 2026-10-01, which is the exact failure `inviteMessage` was written
 * to prevent on the owner side.
 */
describe("ownerInviteMessage", () => {
  const link = "https://aura.sirahagents.com/admin/invite/abc123";

  it("carries the address the invite is bound to, and the one-use rule", () => {
    const text = ownerInviteMessage({ email: "riyaz@acme.com", link, workspace: "Acme" });
    expect(text).toContain("riyaz@acme.com");
    expect(text).toMatch(/only works for that address/i);
    expect(text).toMatch(/used once/i);
  });

  it("says they are being made the owner of that workspace", () => {
    expect(ownerInviteMessage({ email: "a@b.com", link, workspace: "Sirah Digital" })).toMatch(
      /^You have been invited to Sirah Digital on Aura as its owner\.$/m,
    );
  });

  it("still reads when the workspace name is blank", () => {
    for (const blank of [undefined, null, "", "   "]) {
      const text = ownerInviteMessage({ email: "a@b.com", link, workspace: blank });
      expect(text).toContain("as the owner of a workspace");
      expect(text).not.toMatch(/null|undefined| {2}on Aura/);
    }
  });

  it("states the expiry in UTC and drops it rather than guess", () => {
    expect(ownerInviteMessage({ email: "a@b.com", link, expiresAt: "2026-10-04T07:01:49Z" })).toContain(
      "It expires on 4 Oct 2026 (UTC).",
    );
    const text = ownerInviteMessage({ email: "a@b.com", link, expiresAt: "not-a-date" });
    expect(text).not.toMatch(/expires|Invalid Date/i);
  });

  it("stays plain text and ends with the link", () => {
    const text = ownerInviteMessage({ email: "a@b.com", link, workspace: "Acme" });
    expect(text).not.toMatch(/[*_`]/);
    expect(text.trimEnd().endsWith(link)).toBe(true);
  });
});
