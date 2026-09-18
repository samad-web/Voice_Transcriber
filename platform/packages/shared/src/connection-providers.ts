import { z } from "zod";

/**
 * The email/calendar provider catalogue (PRD Layer 1).
 *
 * Pure data, exactly like crm-providers.ts: onboarding a provider means adding
 * an object to the array below, not branching in a connector. The console
 * renders its connect form from the same spec the API validates against, so
 * what a user fills in and what gets stored cannot drift apart.
 *
 * DELIBERATELY NOT ONE VENDOR. A rep connects the mailbox they already use;
 * the next desk connects a different one. Google and Microsoft cover most
 * people through OAuth, and generic IMAP/SMTP and CalDAV cover everyone else -
 * Fastmail, Zoho, a self-hosted server, anything that speaks the standards -
 * so "any email and any calendar" does not depend on this list growing.
 */

/**
 * `sheets` joined email and calendar for the Google Sheets lead connector
 * (migration 0096). It is a separate capability rather than a flag on the
 * provider because a capability here means "this GRANT actually covered that
 * scope" - a Google account connected before the connector existed has no
 * spreadsheets scope, and treating the provider's support as the account's
 * authorisation would produce a 403 on every sync with no way to explain it.
 */
export const ConnectionCapability = z.enum(["email", "calendar", "sheets"]);
export type ConnectionCapability = z.infer<typeof ConnectionCapability>;

/** How a provider is authenticated. Drives which connect flow the UI offers. */
export const ConnectionAuthKind = z.enum(["oauth2", "basic"]);
export type ConnectionAuthKind = z.infer<typeof ConnectionAuthKind>;

export const ConnectionStatus = z.enum(["active", "expired", "revoked", "error"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/** A non-secret per-connection setting the user supplies (IMAP host, port…). */
export interface ConnectionConfigField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  required: boolean;
  defaultValue?: string;
  /** Rendered as a password input and sealed by encryptSecret() before storage. */
  secret?: boolean;
}

export interface ConnectionProviderSpec {
  id: string;
  label: string;
  blurb: string;
  capabilities: ConnectionCapability[];
  auth: ConnectionAuthKind;

  /** oauth2 only - the provider's endpoints and the scopes we ask for. */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    /** Extra authorize-URL params (Google needs these to return a refresh token). */
    authorizeParams?: Record<string, string>;
    /** Whether to use PKCE. Microsoft requires it for SPA-style clients; harmless elsewhere. */
    pkce: boolean;
    /**
     * Env vars holding the PLATFORM's registered app - the fallback for an
     * organisation that has not brought its own (org_oauth_apps, migration
     * 0120). With neither, the provider is reported as `configured: false` and
     * cannot be connected - the same degrade-don't-fail shape migration 0042
     * uses for pg_trgm.
     */
    clientIdEnv: string;
    clientSecretEnv: string;

    /**
     * What a client ID from this provider looks like, checked when an
     * organisation saves its own app. The commonest setup mistake is pasting
     * the secret (or Microsoft's "Secret ID") into the client ID box, and it
     * is far kinder to say so at save time than to fail the first sign-in
     * with the provider's own error page.
     */
    clientIdPattern: string;
    clientIdHint: string;

    /** Where the app is registered, so the setup form can link straight there. */
    registerUrl: string;
    registerLabel: string;

    /**
     * A directory segment in BOTH endpoint URLs that an organisation may
     * narrow. Microsoft's `common` accepts any work or personal account, but a
     * client that registers a single-tenant app in its own Entra directory
     * must sign in against that directory - `common` refuses a single-tenant
     * app outright (AADSTS50194). Absent for providers with no such concept.
     */
    tenant?: { default: string; label: string; help: string };
  };

  /** basic only - the fields the connect form collects. */
  fields?: ConnectionConfigField[];
}

export const CONNECTION_PROVIDERS: ConnectionProviderSpec[] = [
  {
    id: "google",
    label: "Google",
    blurb: "Gmail and Google Calendar, via your own Google account.",
    capabilities: ["email", "calendar", "sheets"],
    auth: "oauth2",
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar",
        // READONLY, and it is the whole point. Aura reads rows out of a sheet
        // and never writes one back: a lead list is the customer's working
        // document, often edited live by the people phoning through it, and a
        // connector with write access to it is a class of accident there is no
        // reason to be exposed to. Google shows the user which of these it is.
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ],
      // `offline` + `consent` are what make Google return a refresh_token.
      // Without them the connection silently stops working in an hour and the
      // user is asked to reconnect for no visible reason.
      authorizeParams: { access_type: "offline", prompt: "consent" },
      pkce: true,
      clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
      clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      clientIdPattern: "^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$",
      clientIdHint: "Ends in .apps.googleusercontent.com.",
      registerUrl: "https://console.cloud.google.com/auth/clients",
      registerLabel: "Google Cloud Console",
    },
  },
  {
    id: "microsoft",
    label: "Microsoft 365 / Outlook",
    blurb: "Outlook mail and calendar, via your own Microsoft account.",
    capabilities: ["email", "calendar"],
    auth: "oauth2",
    oauth: {
      // `common` so both work and personal accounts can connect; a tenant that
      // wants to restrict this points the variables at its own registration.
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: [
        "openid",
        "email",
        "offline_access",
        "https://graph.microsoft.com/Mail.ReadWrite",
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/Calendars.ReadWrite",
      ],
      pkce: true,
      clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
      clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
      clientIdPattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      clientIdHint: "The Application (client) ID from the app's Overview - a GUID.",
      registerUrl:
        "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      registerLabel: "Microsoft Entra admin center",
      tenant: {
        default: "common",
        label: "Directory (tenant) ID",
        help:
          "Leave blank if the app accepts any Microsoft account. If you registered it for your " +
          "organisation only, paste the Directory (tenant) ID from its Overview page.",
      },
    },
  },
  {
    id: "imap",
    label: "Any other mailbox (IMAP/SMTP)",
    blurb: "Fastmail, Zoho, a company mail server - anything speaking IMAP and SMTP.",
    capabilities: ["email"],
    auth: "basic",
    fields: [
      { key: "imap_host", label: "IMAP host", placeholder: "imap.example.com", required: true },
      { key: "imap_port", label: "IMAP port", defaultValue: "993", required: true },
      { key: "smtp_host", label: "SMTP host", placeholder: "smtp.example.com", required: true },
      { key: "smtp_port", label: "SMTP port", defaultValue: "465", required: true },
      {
        key: "password",
        label: "Password or app password",
        help: "Most providers want an app-specific password rather than your login password.",
        required: true,
        secret: true,
      },
    ],
  },
  {
    id: "caldav",
    label: "Any other calendar (CalDAV)",
    blurb: "iCloud, Fastmail, Nextcloud - anything speaking CalDAV.",
    capabilities: ["calendar"],
    auth: "basic",
    fields: [
      {
        key: "caldav_url",
        label: "CalDAV URL",
        placeholder: "https://caldav.example.com/dav/",
        required: true,
      },
      {
        key: "password",
        label: "Password or app password",
        required: true,
        secret: true,
      },
    ],
  },
];

export function connectionProvider(id: string): ConnectionProviderSpec | undefined {
  return CONNECTION_PROVIDERS.find((p) => p.id === id);
}

/**
 * A Microsoft directory: `common`/`organizations`/`consumers`, a tenant GUID,
 * or a verified domain. Strict because the value is spliced into the PATH of
 * the authorize and token URLs - anything looser would let a stored value
 * point the token exchange, client secret and all, somewhere else.
 */
export const DIRECTORY_TENANT =
  /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

/**
 * The authorize and token URLs for one app registration.
 *
 * Only providers that declare `tenant` accept one; for them a blank tenant
 * keeps the catalogue default. Throws on a malformed tenant rather than
 * quietly falling back to `common`, which would send a single-tenant app's
 * users to an endpoint that refuses them with no hint as to why.
 */
export function oauthEndpoints(
  spec: ConnectionProviderSpec,
  tenant?: string | null,
): { authorizeUrl: string; tokenUrl: string } {
  if (!spec.oauth) throw new Error(`${spec.id} is not an oauth provider`);
  const { authorizeUrl, tokenUrl } = spec.oauth;
  const wanted = tenant?.trim();
  if (!spec.oauth.tenant || !wanted) return { authorizeUrl, tokenUrl };
  if (!DIRECTORY_TENANT.test(wanted)) throw new Error(`not a valid directory: ${wanted}`);

  const segment = `/${spec.oauth.tenant.default}/`;
  return {
    authorizeUrl: authorizeUrl.replace(segment, `/${wanted}/`),
    tokenUrl: tokenUrl.replace(segment, `/${wanted}/`),
  };
}

/**
 * An organisation's own OAuth app, as the owner console submits it.
 *
 * `clientSecret` is optional because the secret is WRITE-ONLY: the API never
 * returns it, so a form cannot re-send it. Omitted means "keep the stored
 * one" - which is what lets somebody fix a directory ID without going back to
 * Google or Microsoft for a secret they can no longer see. The API still
 * demands one when there is nothing stored, or when the client ID changes (a
 * different app's secret is never the old one).
 */
export const OAuthAppInput = z.object({
  clientId: z.string().trim().min(8).max(300),
  clientSecret: z.string().trim().min(8).max(500).optional(),
  tenant: z.string().trim().max(120).nullish(),
});
export type OAuthAppInput = z.infer<typeof OAuthAppInput>;

/** The connect form's payload for a `basic` provider. */
export const BasicConnectionInput = z.object({
  provider: z.string().min(1).max(40),
  accountEmail: z.string().email().max(200),
  displayName: z.string().max(160).nullish(),
  /** Raw field values, validated against the spec's own `fields` at the API. */
  config: z.record(z.string(), z.string().max(500)).default({}),
});
export type BasicConnectionInput = z.infer<typeof BasicConnectionInput>;
