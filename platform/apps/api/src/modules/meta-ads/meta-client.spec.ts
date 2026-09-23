import { createHmac } from "node:crypto";
import { signOAuthState, unsubscribePage, verifyOAuthState } from "./meta-client";

/**
 * The signed OAuth state both provider callbacks trust in place of a session,
 * and the Graph unsubscribe that Meta's disconnect calls.
 */

const SECRET = "app-secret";
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000003";

/** A state signed the way the pre-doc-28 code signed it: no person in it. */
function legacyState(orgId: string, expiry: number, secret = SECRET): string {
  const encoded = Buffer.from(`${orgId}.${expiry}`, "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

/** Any payload, correctly signed - for the shapes the signer itself refuses to make. */
function signedPayload(payload: string, secret = SECRET): string {
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

describe("signOAuthState / verifyOAuthState", () => {
  it("round-trips the org and the person", () => {
    const state = signOAuthState(ORG, SECRET, { userId: USER });
    expect(verifyOAuthState(state, SECRET)).toEqual({ orgId: ORG, userId: USER });
  });

  it("round-trips the org alone, with the person null", () => {
    expect(verifyOAuthState(signOAuthState(ORG, SECRET), SECRET)).toEqual({ orgId: ORG, userId: null });
  });

  it("still verifies a state signed before it carried a person", () => {
    // A sign-in already on Facebook's consent screen when this shipped must
    // come back to a clean decision, not a signature failure.
    expect(verifyOAuthState(legacyState(ORG, Date.now() + 60_000), SECRET)).toEqual({
      orgId: ORG,
      userId: null,
    });
  });

  it("refuses an expired state", () => {
    const state = signOAuthState(ORG, SECRET, { userId: USER, ttlMs: -1 });
    expect(verifyOAuthState(state, SECRET)).toBeNull();
    expect(verifyOAuthState(legacyState(ORG, Date.now() - 1), SECRET)).toBeNull();
  });

  it("refuses a state signed with another secret", () => {
    expect(verifyOAuthState(signOAuthState(ORG, "other", { userId: USER }), SECRET)).toBeNull();
  });

  it("refuses a state whose person was swapped after signing", () => {
    // The whole reason the person is inside the signature: otherwise anybody
    // holding a state could make the Pages somebody else's choice.
    const [, sig] = signOAuthState(ORG, SECRET, { userId: USER }).split(".");
    const forged = Buffer.from(
      `${ORG}.${Date.now() + 60_000}.00000000-0000-4000-8000-0000000000b3`,
      "utf8",
    ).toString("base64url");
    expect(verifyOAuthState(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("refuses malformed states rather than throwing", () => {
    for (const bad of ["", ".", "abc", "abc.def", "a.b.c", `${signOAuthState(ORG, SECRET)}.extra`]) {
      expect(verifyOAuthState(bad, SECRET)).toBeNull();
    }
  });

  it("refuses a correctly signed payload with a non-uuid person or extra parts", () => {
    const later = Date.now() + 60_000;
    expect(verifyOAuthState(signedPayload(`${ORG}.${later}.admin-key`), SECRET)).toBeNull();
    expect(verifyOAuthState(signedPayload(`${ORG}.${later}.${USER}.more`), SECRET)).toBeNull();
    expect(verifyOAuthState(signedPayload(`${ORG}`), SECRET)).toBeNull();
  });

  it("refuses to sign a person that is not a uuid", () => {
    // The admin-key path's literal "admin-key" is the realistic mistake.
    expect(() => signOAuthState(ORG, SECRET, { userId: "admin-key" })).toThrow(/uuid/);
  });
});

describe("unsubscribePage", () => {
  it("DELETEs the Page's subscribed_apps edge with the Page token", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return { ok: true, json: async () => ({ success: true }) } as Response;
    }) as unknown as typeof fetch;

    await unsubscribePage("12345", "page-token", fake);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    const url = new URL(calls[0].url);
    expect(url.pathname).toMatch(/\/12345\/subscribed_apps$/);
    expect(url.searchParams.get("access_token")).toBe("page-token");
  });

  it("throws with Meta's status, so the caller can record it", async () => {
    const fake = (async () =>
      ({ ok: false, status: 400, text: async () => "x".repeat(1000) }) as Response) as unknown as typeof fetch;
    await expect(unsubscribePage("12345", "t", fake)).rejects.toThrow(/unsubscription \(400\)/);
  });
});
