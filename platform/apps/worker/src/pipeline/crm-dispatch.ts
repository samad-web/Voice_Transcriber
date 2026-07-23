import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * The structural subset of pg's PoolClient this module uses. Declared here
 * rather than importing pg so the worker doesn't take a direct dependency on
 * the driver it only ever reaches through @aura/db.
 */
export interface DbClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * CRM dispatch: build the outgoing lead, hand it to the outbox, and deliver it.
 *
 * The shape of the request is configuration, not code. `crm_integrations` holds
 * the endpoint, the auth scheme, extra headers and a `field_map` describing the
 * body, so onboarding a second CRM is an INSERT rather than a new provider
 * branch. Delivery itself is generic: 5xx and network errors are retried with
 * exponential backoff, 4xx is terminal because replaying a request the receiver
 * has already rejected will never start working.
 */

// Presigning must use the PUBLIC endpoint. The internal one (http://minio:9000)
// is container DNS — a URL signed against it is unreachable by the CRM, and the
// failure would look like a broken link rather than a config mistake.
const publicS3 = new S3Client({
  endpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "ap-south-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "aura_minio",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "aura_minio_password",
  },
});
const BUCKET = process.env.S3_BUCKET ?? "aura-recordings";
const RECORDING_URL_TTL_S = Number(process.env.CRM_RECORDING_URL_TTL_S ?? 7 * 24 * 3600);

export interface CrmIntegration {
  id: string;
  endpoint: string | null;
  auth_type: "none" | "bearer" | "header";
  auth_header: string;
  auth_secret: string | null;
  headers: Record<string, string> | null;
  field_map: Record<string, string> | null;
  max_attempts: number;
  rate_limit_per_min: number;
  auth: { url?: string } | null;
}

/** Dotted-path lookup into the source document the field_map refers to. */
function pluck(source: Record<string, unknown>, path: string): unknown {
  let cur: unknown = source;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur === undefined ? null : cur;
}

/**
 * Confidence heuristic — NOT a model-reported probability, and documented as
 * such to the receiver. Half the score is how well the extraction validated
 * against the tenant's schema, half is how much of that schema the call
 * actually filled in. A clean extraction of a call that only mentioned two
 * fields should not claim the same confidence as one that filled all ten.
 */
export function confidenceScore(
  validationStatus: string | null,
  factsFilled: number,
  factsTotal: number,
): number | null {
  if (!validationStatus) return null;
  const base = validationStatus === "valid" ? 1 : validationStatus === "repaired" ? 0.8 : 0.5;
  const coverage = factsTotal > 0 ? factsFilled / factsTotal : 0;
  return Number((0.5 * base + 0.5 * coverage).toFixed(2));
}

interface SourceRow {
  id: string;
  direction: string | null;
  started_at: Date | null;
  duration_s: number | null;
  status: string | null;
  remote_name: string | null;
  remote_number_prefix: string | null;
  remote_number_last3: string | null;
  agent_id: string | null;
  agent_version: number | null;
  workspace_id: string;
  instance_id: string | null;
  transcript_text: string | null;
  language: string | null;
  intelligence: Record<string, unknown> | null;
  diarized: boolean | null;
  s3_key: string | null;
  facts: Record<string, unknown> | null;
  validation_status: string | null;
}

/** Everything a field_map may reference, assembled once per call. */
export async function buildSourceDocument(
  client: DbClient,
  callId: string,
): Promise<Record<string, unknown>> {
  const {
    rows: [row],
  } = await client.query<SourceRow>(
    `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
            c.remote_name, c.remote_number_prefix, c.remote_number_last3,
            c.agent_id, c.agent_version, c.workspace_id,
            d.instance_id,
            t.text AS transcript_text, t.language, t.intelligence, t.diarized,
            r.s3_key,
            (SELECT jsonb_object_agg(f.field_key,
                      COALESCE(to_jsonb(f.value_num), to_jsonb(f.value_bool), to_jsonb(f.value_text)))
               FROM call_facts f WHERE f.call_id = c.id) AS facts,
            (SELECT ao.validation_status FROM ai_outputs ao
              WHERE ao.call_id = c.id ORDER BY ao.created_at DESC LIMIT 1) AS validation_status
       FROM calls c
       LEFT JOIN devices d     ON d.id = c.device_id
       LEFT JOIN transcripts t ON t.call_id = c.id
       LEFT JOIN recordings r  ON r.call_id = c.id
      WHERE c.id = $1`,
    [callId],
  );
  if (!row) throw new Error(`call ${callId} not found`);

  const facts = row.facts ?? {};
  const intelligence = row.intelligence ?? {};
  const filled = Object.values(facts).filter((v) => v !== null && v !== "").length;

  // A signed link rather than a permanent one: the bucket is private, and a URL
  // that never expires is a credential handed to a third party.
  let recordingUrl: string | null = null;
  if (row.s3_key) {
    try {
      recordingUrl = await getSignedUrl(
        publicS3,
        new GetObjectCommand({ Bucket: BUCKET, Key: row.s3_key, ResponseContentType: "audio/mp4" }),
        { expiresIn: RECORDING_URL_TTL_S },
      );
    } catch (err) {
      console.error(`call ${callId}: could not presign recording`, err);
    }
  }

  return {
    call: {
      id: row.id,
      direction: row.direction,
      startedAt: row.started_at,
      durationS: row.duration_s,
      status: row.status,
      remoteName: row.remote_name,
      remoteNumberPrefix: row.remote_number_prefix,
      remoteNumberLast3: row.remote_number_last3,
      workspaceId: row.workspace_id,
    },
    facts,
    transcript: {
      text: row.transcript_text,
      language: row.language,
      diarized: row.diarized,
    },
    intelligence,
    meta: {
      instanceId: row.instance_id,
      agentId: row.agent_id,
      agentVersion: row.agent_version,
      timestamp: new Date().toISOString(),
      confidenceScore: confidenceScore(row.validation_status, filled, Object.keys(facts).length),
      recordingUrl,
    },
  };
}

/**
 * Apply the field_map. An empty map preserves the original
 * `{event, call:{…}}` envelope so an integration configured before this change
 * keeps receiving exactly what it did before.
 */
export function mapPayload(
  source: Record<string, unknown>,
  fieldMap: Record<string, string> | null,
): Record<string, unknown> {
  if (!fieldMap || Object.keys(fieldMap).length === 0) {
    return { event: "call.completed", call: { ...(source.call as object), facts: source.facts } };
  }
  const out: Record<string, unknown> = {};
  for (const [dest, path] of Object.entries(fieldMap)) {
    out[dest] = typeof path === "string" ? pluck(source, path) : null;
  }
  return out;
}

function authHeaders(integration: CrmIntegration): Record<string, string> {
  if (!integration.auth_secret) return {};
  if (integration.auth_type === "bearer") {
    return { authorization: `Bearer ${integration.auth_secret}` };
  }
  if (integration.auth_type === "header") {
    return { [integration.auth_header || "X-API-Key"]: integration.auth_secret };
  }
  return {};
}

export interface DeliveryOutcome {
  ok: boolean;
  /** Terminal outcomes are never retried — a 4xx will not start succeeding. */
  terminal: boolean;
  status: number | null;
  body: string;
  error: string | null;
  /** Seconds the receiver asked us to wait, if it said so. */
  retryAfterS: number | null;
}

export async function deliver(
  integration: CrmIntegration,
  payload: Record<string, unknown>,
  requestId: string,
): Promise<DeliveryOutcome> {
  const url = integration.endpoint ?? integration.auth?.url;
  if (!url) {
    return {
      ok: false,
      terminal: true,
      status: null,
      body: "",
      error: "integration has no endpoint configured",
      retryAfterS: null,
    };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        ...(integration.headers ?? {}),
        ...authHeaders(integration),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });

    // Cap what we store: a receiver that answers with an HTML error page should
    // not be able to bloat the outbox row.
    const body = (await res.text().catch(() => "")).slice(0, 4000);
    const retryAfter = Number(res.headers.get("retry-after"));

    return {
      ok: res.ok,
      // 408 and 429 are 4xx but explicitly mean "try again".
      terminal: !res.ok && res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408,
      status: res.status,
      body,
      error: res.ok ? null : `receiver returned ${res.status}`,
      retryAfterS: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    };
  } catch (err) {
    // Timeout / DNS / connection refused — all worth retrying.
    return {
      ok: false,
      terminal: false,
      status: null,
      body: "",
      error: err instanceof Error ? err.message : String(err),
      retryAfterS: null,
    };
  }
}

/** 30s, 2m, 8m, 32m, 2h… capped at 6h, so a long CRM outage backs off politely. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 4 ** Math.max(0, attempt - 1), 6 * 3600);
}
