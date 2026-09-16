import { z } from "zod";

/**
 * LinkedIn Lead Gen Forms, via the Marketing API (migration 0078).
 *
 * ── WHY THIS CHANNEL IS PULLED AND EVERY OTHER ONE IS PUSHED ──────────────
 *
 * LinkedIn has no lead webhook. Meta will POST a leadgen_id the instant
 * somebody submits; LinkedIn expects you to ask. So this is a sweep, the same
 * shape as meta-mcp-sync, and the latency floor is the sweep interval rather
 * than the network.
 *
 * ── IT DEGRADES INSTEAD OF FAILING ────────────────────────────────────────
 *
 * Access to the Lead Sync API needs a LinkedIn Marketing Developer Platform
 * app that LinkedIn has approved, and nobody can register one on an operator's
 * behalf. So `linkedinConfigured()` reports honestly and every entry point
 * refuses politely rather than throwing - exactly the posture
 * connection-providers.ts takes for the Google and Microsoft OAuth apps, and
 * migration 0042 takes for pg_trgm. The connector ships complete and starts
 * working the day the credentials appear, with no code change.
 *
 * ── SHARED BY THE API AND THE WORKER ──────────────────────────────────────
 *
 * The API runs the OAuth handshake; the worker runs the sweep. Both read this
 * file, so they cannot disagree about which version of the API to speak or how
 * to read a lead out of it - the same reasoning meta-mcp.ts is built on.
 */

/**
 * LinkedIn versions its REST API by date header, not by URL path, and rejects
 * a request that omits it. Pinned rather than "latest" so an upstream change
 * is something a person upgrades deliberately.
 */
export const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION ?? "202401";
const REST_BASE = process.env.LINKEDIN_API_BASE_URL ?? "https://api.linkedin.com/rest";
const AUTH_BASE = process.env.LINKEDIN_AUTH_BASE_URL ?? "https://www.linkedin.com/oauth/v2";

/**
 * `r_marketing_leadgen_automation` is the one that matters - it is what grants
 * lead-form responses, and it is the scope LinkedIn gates behind app review.
 * The rest are needed to name the ad account the forms belong to.
 */
export const LINKEDIN_SCOPES = [
  "r_marketing_leadgen_automation",
  "r_ads",
  "r_ads_reporting",
  "r_organization_admin",
];

export interface LinkedInOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Whether this deployment has a registered LinkedIn app at all. */
export function linkedinConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);
}

export function linkedinOAuthConfig(env: NodeJS.ProcessEnv = process.env): LinkedInOAuthConfig | null {
  if (!linkedinConfigured(env)) return null;
  return {
    clientId: env.LINKEDIN_CLIENT_ID as string,
    clientSecret: env.LINKEDIN_CLIENT_SECRET as string,
    redirectUri: env.LINKEDIN_REDIRECT_URI ?? `${env.API_PUBLIC_URL ?? ""}/v1/linkedin/oauth/callback`,
  };
}

export function linkedinAuthorizeUrl(config: LinkedInOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(" "),
  });
  return `${AUTH_BASE}/authorization?${params.toString()}`;
}

export interface LinkedInTokens {
  accessToken: string;
  /** Seconds. LinkedIn's access tokens last 60 days, not an hour. */
  expiresIn: number | null;
  /** Only issued to apps approved for programmatic refresh. May be absent. */
  refreshToken: string | null;
}

async function tokenRequest(body: URLSearchParams, fetchImpl: typeof fetch): Promise<LinkedInTokens> {
  const res = await fetchImpl(`${AUTH_BASE}/accessToken`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LinkedIn rejected the token request (${res.status}): ${detail.slice(0, 300)}`);
  }
  const parsed = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!parsed.access_token) throw new Error("LinkedIn returned no access_token");
  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : null,
    refreshToken: parsed.refresh_token ?? null,
  };
}

export function exchangeLinkedInCode(
  config: LinkedInOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkedInTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }),
    fetchImpl,
  );
}

export function refreshLinkedInToken(
  config: LinkedInOAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkedInTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    fetchImpl,
  );
}

function restHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "linkedin-version": LINKEDIN_API_VERSION,
    "x-restli-protocol-version": "2.0.0",
    accept: "application/json",
  };
}

/** An HTTP failure that says whether reconnecting would help. */
export class LinkedInHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LinkedInHttpError";
  }

  /** 401/403: the grant is gone. Retrying burns quota and never succeeds. */
  get needsReconnect(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function restGet(path: string, accessToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(`${REST_BASE}${path}`, { headers: restHeaders(accessToken) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LinkedInHttpError(res.status, `LinkedIn ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export interface LinkedInAdAccount {
  urn: string;
  name: string | null;
}

/**
 * The ad accounts this grant can see, so a person picks one by name instead of
 * pasting a urn they would have to go and find.
 */
export async function listAdAccounts(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkedInAdAccount[]> {
  const body = (await restGet("/adAccounts?q=search", accessToken, fetchImpl)) as {
    elements?: Array<{ id?: number | string; name?: string; urn?: string }>;
  };
  return (body.elements ?? []).map((element) => ({
    urn: element.urn ?? `urn:li:sponsoredAccount:${element.id}`,
    name: element.name ?? null,
  }));
}

// ── lead form responses ───────────────────────────────────────────────────

const AnswerDetails = z.object({
  textQuestionAnswer: z.object({ answer: z.string() }).optional(),
});

const Answer = z.object({
  questionId: z.union([z.string(), z.number()]).optional(),
  /** Some versions name the field rather than referencing a question id. */
  name: z.string().optional(),
  question: z.string().optional(),
  answerDetails: AnswerDetails.optional(),
  answer: z.string().optional(),
});

const LeadFormResponse = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  submittedAt: z.union([z.string(), z.number()]).optional(),
  leadType: z.string().optional(),
  campaign: z.string().optional(),
  campaignName: z.string().optional(),
  creative: z.string().optional(),
  form: z.string().optional(),
  formName: z.string().optional(),
  versionedLeadGenFormUrn: z.string().optional(),
  formResponse: z.object({ answers: z.array(Answer).optional() }).optional(),
  answers: z.array(Answer).optional(),
});

export interface NormalizedLinkedInLead {
  /** The response id - the idempotency key for the whole ingest path. */
  leadId: string;
  submittedAt: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  /** Form name, campaign, and every free-text answer - what project detection reads. */
  text: string;
  raw: unknown;
}

/**
 * LinkedIn's own question ids for the fields it offers as built-ins. Custom
 * questions carry the form author's own wording, which is why the matcher
 * falls back to substring on the question text.
 */
const ANSWER_ALIASES = {
  firstName: ["firstname", "first_name", "givenname"],
  lastName: ["lastname", "last_name", "familyname", "surname"],
  fullName: ["fullname", "full_name", "name"],
  email: ["emailaddress", "email", "workemail", "work_email"],
  phone: ["phonenumber", "phone", "mobile", "mobilenumber", "workphone"],
  company: ["companyname", "company", "organization", "organisation"],
} as const;

function answerKey(answer: z.infer<typeof Answer>): string {
  return String(answer.questionId ?? answer.name ?? answer.question ?? "")
    .toLowerCase()
    .replace(/[^a-z]/gu, "");
}

function answerValue(answer: z.infer<typeof Answer>): string | null {
  const value = answer.answerDetails?.textQuestionAnswer?.answer ?? answer.answer;
  return value && value.trim() ? value.trim() : null;
}

function findAnswer(answers: Array<z.infer<typeof Answer>>, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const hit = answers.find((answer) => answerKey(answer).includes(alias.replace(/[^a-z]/gu, "")));
    const value = hit ? answerValue(hit) : null;
    if (value) return value;
  }
  return null;
}

/**
 * Turn a `leadFormResponses` page into leads.
 *
 * Tolerant in the same two directions meta-mcp's normaliser is, and for the
 * same reason: LinkedIn has moved this payload's shape between API versions,
 * and a lead that arrives in a shape we do not recognise should be dropped
 * loudly rather than invented from a field we guessed at. A response with no
 * id is skipped - the id IS the idempotency key, and synthesising one would
 * re-ingest the same lead on every sweep, forever.
 */
export function normalizeLinkedInLeads(payload: unknown): NormalizedLinkedInLead[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { elements?: unknown })?.elements)
      ? (payload as { elements: unknown[] }).elements
      : [];

  const out: NormalizedLinkedInLead[] = [];
  for (const entry of list) {
    const parsed = LeadFormResponse.safeParse(entry);
    if (!parsed.success) continue;
    const response = parsed.data;
    const id = response.id;
    if (id === undefined || String(id).trim() === "") continue;

    const answers = response.formResponse?.answers ?? response.answers ?? [];
    const first = findAnswer(answers, ANSWER_ALIASES.firstName);
    const last = findAnswer(answers, ANSWER_ALIASES.lastName);
    const fullName =
      findAnswer(answers, ANSWER_ALIASES.fullName) ||
      [first, last].filter(Boolean).join(" ").trim() ||
      null;

    const submittedAt =
      typeof response.submittedAt === "number"
        ? new Date(response.submittedAt).toISOString()
        : (response.submittedAt ?? null);

    out.push({
      leadId: String(id),
      submittedAt,
      fullName,
      email: findAnswer(answers, ANSWER_ALIASES.email),
      phone: findAnswer(answers, ANSWER_ALIASES.phone),
      company: findAnswer(answers, ANSWER_ALIASES.company),
      // Form and campaign names first - the most reliable place a project is
      // named - then every answer, so a free-text "what do you need?" counts.
      text: [
        response.formName,
        response.campaignName,
        response.form,
        response.campaign,
        ...answers.map((answer) => answerValue(answer) ?? ""),
      ]
        .filter((part) => typeof part === "string" && part.trim().length > 0)
        .join(" \n "),
      raw: entry,
    });
  }
  return out;
}

/**
 * One page of lead-form responses for an ad account, submitted since `since`.
 *
 * A window rather than an opaque cursor, because the sweep's stored cursor is a
 * timestamp that a person can move backwards by hand to force a backfill - and
 * because overlapping windows are free when the claim is idempotent.
 */
export async function fetchLeadFormResponses(
  accountUrn: string,
  accessToken: string,
  since: Date,
  limit = 100,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedLinkedInLead[]> {
  const owner = accountUrn.includes(":organization:")
    ? `(organization:${accountUrn})`
    : `(sponsoredAccount:${accountUrn})`;
  const range = `(start:${since.getTime()},end:${Date.now()})`;
  const path =
    `/leadFormResponses?q=owner&owner=${encodeURIComponent(owner)}` +
    `&submittedAtTimeRange=${encodeURIComponent(range)}&count=${limit}`;
  return normalizeLinkedInLeads(await restGet(path, accessToken, fetchImpl));
}
