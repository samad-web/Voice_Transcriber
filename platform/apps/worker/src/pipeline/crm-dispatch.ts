import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { decryptSecret } from "@aura/db";
import {
  isFilled,
  pluckPath,
  pruneBody,
  renderBody,
  resolveCrmRequest,
  type CrmAuthScheme,
  type CrmMethod,
  type ResolvedCrmRequest,
} from "@aura/shared";

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
 * The request is configuration, not code. `crm_integrations` holds the endpoint
 * template, the per-tenant config that completes it, the auth scheme, the body
 * shape and the field map — so onboarding a CRM is an INSERT plus an entry in
 * the shared catalogue, never a new branch here. This file knows how to render
 * and send a request; it knows nothing about HubSpot or Zoho specifically.
 *
 * Delivery is generic: 5xx and network errors retry with exponential backoff,
 * 4xx is terminal because replaying a request the receiver already rejected
 * will never start working.
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
  provider: string;
  label: string | null;
  target: string | null;
  endpoint: string | null;
  method: CrmMethod;
  auth_type: CrmAuthScheme;
  auth_header: string;
  auth_prefix: string;
  auth_secret: string | null;
  headers: Record<string, string> | null;
  config: Record<string, unknown> | null;
  body_template: unknown;
  id_path: string | null;
  pair_keys: string[] | null;
  field_map: Record<string, string> | null;
  max_attempts: number;
  rate_limit_per_min: number;
  auth: { url?: string } | null;
  /** Send only calls that qualified as a lead — see enqueueDispatch (0011). */
  only_qualified: boolean;
}

/** Dotted-path lookup into the source document the field_map refers to. */
const pluck = pluckPath;

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
  remote_number_full: string | null;
  remote_number_hash: string | null;
  contact_calls_in: string | number | null;
  contact_calls_out: string | number | null;
  contact_sequence: string | number | null;
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
            c.remote_number_full, c.remote_number_hash,
            c.agent_id, c.agent_version, c.workspace_id,
            d.instance_id,
            -- Contact history, counted live rather than stored on the row.
            -- Retention and erasure sweeps delete calls, so a stored counter
            -- would drift; the (workspace_id, remote_number_hash) index makes
            -- recomputing it cheap. NULL hash (number withheld) yields no
            -- history, which is the honest answer rather than "first call".
            (SELECT count(*) FILTER (WHERE x.direction = 'incoming')
               FROM calls x
              WHERE x.workspace_id = c.workspace_id
                AND x.remote_number_hash IS NOT NULL
                AND x.remote_number_hash = c.remote_number_hash) AS contact_calls_in,
            (SELECT count(*) FILTER (WHERE x.direction = 'outgoing')
               FROM calls x
              WHERE x.workspace_id = c.workspace_id
                AND x.remote_number_hash IS NOT NULL
                AND x.remote_number_hash = c.remote_number_hash) AS contact_calls_out,
            -- Where THIS call sits in that history. Ties broken by id so two
            -- calls sharing a timestamp still get distinct, stable ordinals.
            (SELECT count(*)
               FROM calls x
              WHERE x.workspace_id = c.workspace_id
                AND x.remote_number_hash IS NOT NULL
                AND x.remote_number_hash = c.remote_number_hash
                AND (x.started_at, x.id) <= (c.started_at, c.id)) AS contact_sequence,
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
  // `isFilled`, not a local test, because this number is half of the confidence
  // the receiver is told. A local `v !== null && v !== ""` counted a
  // whitespace-only string and the literal "[]" (how call_facts stores an empty
  // string[]) as answers — exactly what a model emits for "not mentioned" — so a
  // call qualifyLead scores as ZERO filled fields arrived in the customer's CRM
  // at confidence 1.0, overstating precisely the leads that deserve least trust.
  // One definition of "the call said something", shared with qualifyLead.
  const filled = Object.values(facts).filter(isFilled).length;

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
      // NULL unless the org opted in (0011) — a field map that references it on
      // a non-opted-in tenant simply sends nothing, rather than a partial number.
      remoteNumber: row.remote_number_full,
      workspaceId: row.workspace_id,
    },
    /**
     * The caller, across calls.
     *
     * Until this existed the payload carried nothing that identified WHO rang:
     * `callId` is unique per call and `customerName` is LLM-extracted and often
     * absent, so a receiving CRM had no way to tell two deliveries apart from
     * two different customers. `key` is the number hash — stable, already
     * indexed, and not reversible into a dialable number, so it can be sent to
     * a third party without widening what we disclose about callers.
     *
     * `isFollowUp` is simply "we have spoken before": the second and later call
     * on the same number, whoever placed it. It needs no model and cannot be
     * wrong in the way an inferred outcome can.
     */
    contact: {
      key: row.remote_number_hash,
      label: row.remote_name ?? null,
      /**
       * A readable number for humans, assembled from the fragments that are
       * stored even when the full number is not.
       *
       * This is the only phone-ish value that exists for calls ingested before
       * an org opted in to `store_full_number` — that flag is not retroactive,
       * because the digits were never written. Sending it means a CRM row for a
       * historical call still shows something a person can recognise, instead
       * of an empty field next to `call.remoteNumber`.
       */
      masked:
        row.remote_number_prefix || row.remote_number_last3
          ? `${row.remote_number_prefix ?? "…"}…${row.remote_number_last3 ?? ""}`
          : null,
      // NULL, not 0, when the number was withheld: there is no history to
      // count, and pruneBody drops nulls so the CRM field stays empty instead
      // of displaying "0 calls" against a call that obviously happened. Zero is
      // a claim; absent is the truth.
      callsIn: row.remote_number_hash ? Number(row.contact_calls_in ?? 0) : null,
      callsOut: row.remote_number_hash ? Number(row.contact_calls_out ?? 0) : null,
      callsTotal: row.remote_number_hash
        ? Number(row.contact_calls_in ?? 0) + Number(row.contact_calls_out ?? 0)
        : null,
      sequence: row.remote_number_hash ? Number(row.contact_sequence ?? 1) : null,
      // Not "unknown": we cannot show it is a repeat, so it is not flagged as
      // one. A false here is a safe default for a boolean column downstream.
      isFollowUp: row.remote_number_hash ? Number(row.contact_sequence ?? 1) > 1 : false,
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
 * Apply the field_map, producing the flat destination object.
 *
 * An empty map preserves the original `{event, call:{…}}` envelope so an
 * integration configured before the connector work keeps receiving exactly
 * what it did before.
 */
export function mapFields(
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

/**
 * Field map, then the provider's body shape. Kept as one exported step so the
 * console's payload preview and the worker's real send go through the same
 * call — a preview that lies is worse than no preview.
 */
export function mapPayload(
  source: Record<string, unknown>,
  integration: Pick<CrmIntegration, "field_map" | "body_template" | "config" | "pair_keys">,
): unknown {
  const fields = mapFields(source, integration.field_map);
  const vars = integration.config ?? {};
  const pairKeys = integration.pair_keys;
  return pruneBody(
    renderBody(integration.body_template ?? null, fields, vars, {
      pairKeys:
        pairKeys && pairKeys.length === 2 ? [pairKeys[0], pairKeys[1]] : undefined,
    }),
  );
}

const b64 = (input: string) => Buffer.from(input, "utf8").toString("base64");

/**
 * Resolve the integration into a concrete request: interpolate the endpoint
 * and headers from config, attach the credential, decrypt the secret.
 *
 * Returns the unresolved placeholders instead of sending a request built from
 * blanks — a Salesforce integration missing its instance URL should fail
 * saying so, not POST to a nonsense host.
 */
export function resolveRequest(integration: CrmIntegration): ResolvedCrmRequest & {
  error: string | null;
} {
  const endpoint = integration.endpoint ?? integration.auth?.url ?? "";
  if (!endpoint) {
    return {
      url: "",
      method: integration.method ?? "POST",
      headers: {},
      missing: [],
      error: "integration has no endpoint configured",
    };
  }

  let secret: string | null = null;
  try {
    secret = decryptSecret(integration.auth_secret);
  } catch (err) {
    return {
      url: endpoint,
      method: integration.method ?? "POST",
      headers: {},
      missing: [],
      error: `credential could not be decrypted: ${(err as Error).message}`,
    };
  }

  const resolved = resolveCrmRequest(
    {
      endpoint,
      method: integration.method,
      authType: integration.auth_type,
      authHeader: integration.auth_header,
      authPrefix: integration.auth_prefix,
      headers: integration.headers,
      config: integration.config,
    },
    secret,
    b64,
  );
  return { ...resolved, error: null };
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
  /** The id the CRM gave the record it created, if id_path found one. */
  externalId: string | null;
  /** The URL actually called, recorded so a 404 is diagnosable. */
  url: string;
}

function failure(error: string, url = ""): DeliveryOutcome {
  return {
    ok: false,
    terminal: true,
    status: null,
    body: "",
    error,
    retryAfterS: null,
    externalId: null,
    url,
  };
}

export async function deliver(
  integration: CrmIntegration,
  payload: unknown,
  requestId: string,
): Promise<DeliveryOutcome> {
  const request = resolveRequest(integration);
  if (request.error) return failure(request.error, request.url);
  if (request.missing.length > 0) {
    // Terminal: a missing config value will still be missing on the next try.
    return failure(
      `integration is missing required configuration: ${request.missing.join(", ")}`,
      request.url,
    );
  }

  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-request-id": requestId,
        ...request.headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });

    // Cap what we store: a receiver that answers with an HTML error page should
    // not be able to bloat the outbox row.
    const raw = await res.text().catch(() => "");
    const body = raw.slice(0, 4000);
    const retryAfter = Number(res.headers.get("retry-after"));

    let externalId: string | null = null;
    if (res.ok && integration.id_path) {
      try {
        const found = pluck(JSON.parse(raw), integration.id_path);
        if (found !== null && found !== undefined) externalId = String(found);
      } catch {
        // Non-JSON success body — the delivery worked, we just can't link it.
      }
    }

    return {
      ok: res.ok,
      // 408 and 429 are 4xx but explicitly mean "try again".
      terminal:
        !res.ok && res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408,
      status: res.status,
      body,
      error: res.ok ? null : `receiver returned ${res.status}`,
      retryAfterS: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      externalId,
      url: request.url,
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
      externalId: null,
      url: request.url,
    };
  }
}

/** 30s, 2m, 8m, 32m, 2h… capped at 6h, so a long CRM outage backs off politely. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 4 ** Math.max(0, attempt - 1), 6 * 3600);
}
