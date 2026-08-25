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
 * people through OAuth, and generic IMAP/SMTP and CalDAV cover everyone else —
 * Fastmail, Zoho, a self-hosted server, anything that speaks the standards —
 * so "any email and any calendar" does not depend on this list growing.
 */

export const ConnectionCapability = z.enum(["email", "calendar"]);
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

  /** oauth2 only — the provider's endpoints and the scopes we ask for. */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    /** Extra authorize-URL params (Google needs these to return a refresh token). */
    authorizeParams?: Record<string, string>;
    /** Whether to use PKCE. Microsoft requires it for SPA-style clients; harmless elsewhere. */
    pkce: boolean;
    /**
     * Env vars holding the registered app's credentials. A provider whose
     * variables are unset is reported as `configured: false` and cannot be
     * connected — the same degrade-don't-fail shape migration 0042 uses for
     * pg_trgm. Nobody can register an OAuth app on the operator's behalf, so
     * the software has to be honest about not being set up rather than
     * throwing when somebody clicks Connect.
     */
    clientIdEnv: string;
    clientSecretEnv: string;
  };

  /** basic only — the fields the connect form collects. */
  fields?: ConnectionConfigField[];
}

export const CONNECTION_PROVIDERS: ConnectionProviderSpec[] = [
  {
    id: "google",
    label: "Google",
    blurb: "Gmail and Google Calendar, via your own Google account.",
    capabilities: ["email", "calendar"],
    auth: "oauth2",
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar",
      ],
      // `offline` + `consent` are what make Google return a refresh_token.
      // Without them the connection silently stops working in an hour and the
      // user is asked to reconnect for no visible reason.
      authorizeParams: { access_type: "offline", prompt: "consent" },
      pkce: true,
      clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
      clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
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
    },
  },
  {
    id: "imap",
    label: "Any other mailbox (IMAP/SMTP)",
    blurb: "Fastmail, Zoho, a company mail server — anything speaking IMAP and SMTP.",
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
    blurb: "iCloud, Fastmail, Nextcloud — anything speaking CalDAV.",
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

/** The connect form's payload for a `basic` provider. */
export const BasicConnectionInput = z.object({
  provider: z.string().min(1).max(40),
  accountEmail: z.string().email().max(200),
  displayName: z.string().max(160).nullish(),
  /** Raw field values, validated against the spec's own `fields` at the API. */
  config: z.record(z.string(), z.string().max(500)).default({}),
});
export type BasicConnectionInput = z.infer<typeof BasicConnectionInput>;
