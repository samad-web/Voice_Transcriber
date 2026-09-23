import {
  type ConnectErrorCode,
  connectReturnUrl,
  consoleBaseUrl,
  oauthParam,
  providerErrorCode,
} from "./console-redirect";

/**
 * Where an API-side OAuth callback sends the browser (doc 28 §11.3). Pure
 * functions, so every shape the console's connect page has to parse is pinned
 * here rather than discovered in a browser.
 */

const PROD = { PUBLIC_APP_URL: "https://app.example.com/admin" } as NodeJS.ProcessEnv;

describe("connectReturnUrl", () => {
  it("sends a finished sign-in to the choose step, carrying only the pending id", () => {
    const url = new URL(
      connectReturnUrl("meta_lead_ads", { step: "choose", pending: "8f0c6d1e-2a3b-4c5d-9e8f-0a1b2c3d4e5f" }, PROD),
    );
    expect(url.origin + url.pathname).toBe(
      "https://app.example.com/admin/owner/integrations/meta_lead_ads/connect",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      step: "choose",
      pending: "8f0c6d1e-2a3b-4c5d-9e8f-0a1b2c3d4e5f",
    });
  });

  it.each<ConnectErrorCode>(["denied", "expired", "no_pages", "no_accounts", "provider_error"])(
    "sends a failed sign-in back to the auth step with the code %s and nothing else",
    (error) => {
      const url = new URL(connectReturnUrl("linkedin_ads", { step: "auth", error }, PROD));
      expect(url.pathname).toBe("/admin/owner/integrations/linkedin_ads/connect");
      expect(Object.fromEntries(url.searchParams)).toEqual({ step: "auth", error });
    },
  );

  it("drops trailing slashes from PUBLIC_APP_URL rather than doubling them", () => {
    const env = { PUBLIC_APP_URL: "https://app.example.com/admin///" } as NodeJS.ProcessEnv;
    expect(connectReturnUrl("meta_lead_ads", { step: "auth", error: "expired" }, env)).toBe(
      "https://app.example.com/admin/owner/integrations/meta_lead_ads/connect?step=auth&error=expired",
    );
  });

  it("falls back to the local console when PUBLIC_APP_URL is unset or blank", () => {
    for (const env of [{}, { PUBLIC_APP_URL: "" }, { PUBLIC_APP_URL: "   " }] as NodeJS.ProcessEnv[]) {
      expect(connectReturnUrl("meta_lead_ads", { step: "auth", error: "denied" }, env)).toBe(
        "http://localhost:3000/owner/integrations/meta_lead_ads/connect?step=auth&error=denied",
      );
    }
  });

  it("keeps the console's basePath, which PUBLIC_APP_URL already carries", () => {
    expect(consoleBaseUrl(PROD)).toBe("https://app.example.com/admin");
  });
});

describe("providerErrorCode", () => {
  it("is null when the provider sent no error at all", () => {
    expect(providerErrorCode(undefined, undefined)).toBeNull();
    expect(providerErrorCode("")).toBeNull();
  });

  it.each([
    ["Facebook's Cancel", ["access_denied", "user_denied"]],
    ["Facebook, reason only", [undefined, "user_denied"]],
    ["LinkedIn's Cancel on the sign-in", ["user_cancelled_login"]],
    ["LinkedIn's Cancel on the consent", ["user_cancelled_authorize"]],
  ])("reads %s as a person saying no", (_label, values) => {
    expect(providerErrorCode(...(values as Array<string | undefined>))).toBe("denied");
  });

  it("reads any other provider error as the provider's problem, not the person's choice", () => {
    expect(providerErrorCode("server_error")).toBe("provider_error");
    expect(providerErrorCode("invalid_scope", "whatever")).toBe("provider_error");
  });
});

describe("oauthParam", () => {
  it("passes a plain string through", () => {
    expect(oauthParam("abc")).toBe("abc");
  });

  it("refuses what Express makes of a repeated or bracketed parameter", () => {
    expect(oauthParam(["a", "b"])).toBeUndefined();
    expect(oauthParam({ nested: "x" })).toBeUndefined();
    expect(oauthParam("")).toBeUndefined();
    expect(oauthParam(undefined)).toBeUndefined();
  });
});
