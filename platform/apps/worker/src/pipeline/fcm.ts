import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Firebase Cloud Messaging from the worker (doc 33 §4: the `presence_check`
 * push when a phone's heartbeats stop mid-shift).
 *
 * ── SAME CREDENTIAL, SAME RULES AS THE API ──────────────────────────────────
 *
 * Reads exactly what apps/api/src/fcm/fcm.service.ts reads, in the same order
 * and with the same reasoning: FIREBASE_SERVICE_ACCOUNT_B64 (containers - the
 * secret arrives through env_file with every other one) wins over
 * FIREBASE_SERVICE_ACCOUNT_PATH (local dev). Neither set, or unreadable = push
 * disabled and every send returns false; nothing here ever stops the worker
 * booting. The service account itself is never logged.
 *
 * ── WHY NOT firebase-admin ──────────────────────────────────────────────────
 *
 * The worker does not depend on it, and adding it would change the workspace
 * lockfile, which this change was not allowed to touch. The send is FCM's
 * documented HTTP v1 API with a service-account JWT - the same two requests
 * firebase-admin makes - in a few dozen lines with no dependency. Moving the
 * API's sender and this one into a shared package is the natural follow-up.
 *
 * Callers must never depend on delivery for correctness: a phone that misses a
 * `presence_check` still uploads its own log when it next can (doc 33 §4
 * rules 3 and 11), and a stale token is normal.
 */

interface ServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

let account: ServiceAccount | null | undefined;
let accessToken: { value: string; expiresAt: number } | null = null;
let warned = false;

/** The service account, or null - never throws. Exported for the test. */
export function readServiceAccount(env: NodeJS.ProcessEnv = process.env): ServiceAccount | null {
  const b64 = env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    try {
      return JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as ServiceAccount;
    } catch {
      console.error("FIREBASE_SERVICE_ACCOUNT_B64 is not base64-encoded JSON - worker FCM push disabled");
      return null;
    }
  }
  const keyPath = env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!keyPath) return null;
  try {
    return JSON.parse(readFileSync(resolve(keyPath), "utf-8")) as ServiceAccount;
  } catch {
    console.error(`Could not read the Firebase service account at ${keyPath} - worker FCM push disabled`);
    return null;
  }
}

function credential(): ServiceAccount | null {
  if (account === undefined) {
    const read = readServiceAccount();
    account = read?.client_email && read.private_key && read.project_id ? read : null;
    if (!account && !warned) {
      warned = true;
      console.warn("worker FCM push disabled (no usable FIREBASE_SERVICE_ACCOUNT_B64 / _PATH)");
    }
  }
  return account;
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The signed assertion Google's token endpoint exchanges for an access token. Exported for the test. */
export function serviceAccountJwt(sa: Required<Pick<ServiceAccount, "client_email" | "private_key">> & ServiceAccount, nowS: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri ?? DEFAULT_TOKEN_URI,
      iat: nowS,
      exp: nowS + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

async function getAccessToken(sa: ServiceAccount, fetchImpl: typeof fetch): Promise<string | null> {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;
  const jwt = serviceAccountJwt(sa as Required<Pick<ServiceAccount, "client_email" | "private_key">>, Math.floor(Date.now() / 1000));
  const res = await fetchImpl(sa.token_uri ?? DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  if (!res.ok) {
    console.warn(`worker FCM: token exchange refused (${res.status})`);
    return null;
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;
  accessToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return accessToken.value;
}

/**
 * A data-only, high-priority push to one handset - the same shape the API
 * sends (`android.priority: HIGH` wakes it from Doze). True when FCM accepted
 * it; false on anything else, never a throw.
 */
export async function sendPush(
  fcmToken: string,
  data: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const sa = credential();
  if (!sa) return false;
  try {
    const token = await getAccessToken(sa, fetchImpl);
    if (!token) return false;
    const res = await fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id!)}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token: fcmToken, data, android: { priority: "HIGH" } } }),
      },
    );
    if (res.ok) return true;
    if (res.status === 401) accessToken = null;
    // 404 UNREGISTERED is a stale token (app reinstalled, token rotated) - normal.
    if (res.status !== 404) console.warn(`worker FCM push failed (${res.status})`);
    return false;
  } catch (err) {
    console.warn(`worker FCM push failed: ${(err as Error).message}`);
    return false;
  }
}

/** Test seam: forget the cached credential and token. */
export function resetFcmForTests(): void {
  account = undefined;
  accessToken = null;
  warned = false;
}
