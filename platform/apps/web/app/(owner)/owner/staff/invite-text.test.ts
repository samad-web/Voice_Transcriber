import { describe, expect, it } from "vitest";
import { inviteMessage } from "./invite-text";

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
