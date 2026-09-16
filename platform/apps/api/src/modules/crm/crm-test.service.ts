import { Injectable, NotFoundException } from "@nestjs/common";
import { assertPublicHttpUrl, decryptSecret } from "@aura/db";
import {
  pluckPath,
  pruneBody,
  renderBody,
  resolveCrmRequest,
  type CrmAuthScheme,
  type CrmMethod,
} from "@aura/shared";
import { DbService } from "../../db/db.service";

/**
 * "Test connection" for a CRM integration.
 *
 * The failure this exists to prevent: an operator saves a connector with a
 * typo'd token, nothing looks wrong, and the mistake surfaces days later as a
 * dead outbox row for a call that has already been lost. Testing at configure
 * time makes the credential prove itself while someone is still looking at the
 * form.
 *
 * It renders through the same @aura/shared functions the worker uses, so a
 * passing test is evidence about the real request and not about a lookalike.
 */

interface IntegrationRow {
  id: string;
  provider: string;
  label: string | null;
  target: string | null;
  workspace_id: string;
  endpoint: string | null;
  method: CrmMethod | null;
  auth_type: CrmAuthScheme;
  auth_header: string | null;
  auth_prefix: string | null;
  auth_secret: string | null;
  headers: Record<string, string> | null;
  config: Record<string, unknown> | null;
  body_template: unknown;
  id_path: string | null;
  pair_keys: string[] | null;
  field_map: Record<string, string> | null;
}

export interface CrmTestResult {
  ok: boolean;
  dryRun: boolean;
  /** Where the request went (or would have gone), after interpolation. */
  url: string;
  method: string;
  /** Header names only - the value of an Authorization header is the secret. */
  headerNames: string[];
  payload: unknown;
  /** Which call the sample came from, or null when it is synthetic. */
  sampleCallId: string | null;
  status: number | null;
  responseBody: string | null;
  externalId: string | null;
  error: string | null;
  /** Config placeholders the templates need but nothing supplies. */
  missing: string[];
}

/**
 * Stand-in used when the workspace has no completed call yet - a new tenant
 * should be able to verify a connector before their first call, not after.
 * Shaped exactly like buildSourceDocument's output so field maps resolve.
 */
function syntheticSource(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    call: {
      id: "00000000-0000-4000-8000-0000000000ff",
      direction: "incoming",
      startedAt: now,
      durationS: 184,
      status: "COMPLETE",
      remoteName: "Aura Test Contact",
      remoteNumberPrefix: "+9198765XXX",
      remoteNumberLast3: "321",
      // Only opted-in orgs send this for real (0011); the sample always carries
      // one so a field map referencing it can be tested before the first call.
      remoteNumber: "919876543321",
      workspaceId: "00000000-0000-4000-8000-000000000002",
    },
    facts: {
      intent: "hot",
      company: "Aura Test Co",
      budget: 50000,
    },
    transcript: {
      text: "This is a connection test from Aura. No real call was involved.",
      language: "en",
      diarized: true,
    },
    intelligence: {
      summary: "Connection test from Aura - verifying this integration accepts a lead.",
      overall_intent: "Aura connection test",
      customer_intent: "n/a",
      agent_intent: "n/a",
      sentiment: "neutral",
      outcome: "other",
      key_points: ["aura-test"],
      action_items: [],
    },
    meta: {
      instanceId: null,
      agentId: null,
      agentVersion: null,
      timestamp: now,
      confidenceScore: 1,
      recordingUrl: null,
    },
  };
}

@Injectable()
export class CrmTestService {
  constructor(private readonly db: DbService) {}

  async test(orgId: string, integrationId: string, dryRun: boolean): Promise<CrmTestResult> {
    const { integration, source, sampleCallId } = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<IntegrationRow>(
        `SELECT id, provider, label, target, workspace_id, endpoint, method, auth_type,
                auth_header, auth_prefix, auth_secret, headers, config, body_template,
                id_path, pair_keys, field_map
           FROM crm_integrations WHERE id = $1 AND deleted_at IS NULL`,
        [integrationId],
      );
      if (!row) throw new NotFoundException("crm integration not found in this org");

      // Prefer a real call: it exercises the field map against data that
      // actually exists, which is where mappings usually turn out to be wrong.
      const {
        rows: [sample],
      } = await client.query<{ id: string }>(
        `SELECT id FROM calls
          WHERE workspace_id = $1 AND status = 'COMPLETE'
          ORDER BY started_at DESC LIMIT 1`,
        [row.workspace_id],
      );

      if (!sample) return { integration: row, source: syntheticSource(), sampleCallId: null };
      return {
        integration: row,
        source: await this.sourceForCall(client, sample.id),
        sampleCallId: sample.id,
      };
    });

    const payload = this.buildPayload(integration, source);

    let secret: string | null = null;
    try {
      secret = decryptSecret(integration.auth_secret);
    } catch (err) {
      return {
        ok: false,
        dryRun,
        url: integration.endpoint ?? "",
        method: integration.method ?? "POST",
        headerNames: [],
        payload,
        sampleCallId,
        status: null,
        responseBody: null,
        externalId: null,
        error: `credential could not be decrypted: ${(err as Error).message}`,
        missing: [],
      };
    }

    const request = resolveCrmRequest(
      {
        endpoint: integration.endpoint,
        method: integration.method,
        authType: integration.auth_type,
        authHeader: integration.auth_header,
        authPrefix: integration.auth_prefix,
        headers: integration.headers,
        config: integration.config,
      },
      secret,
      (input) => Buffer.from(input, "utf8").toString("base64"),
    );

    const base: CrmTestResult = {
      ok: false,
      dryRun,
      url: this.redactQuerySecrets(request.url, secret),
      method: request.method,
      headerNames: Object.keys(request.headers),
      payload,
      sampleCallId,
      status: null,
      responseBody: null,
      externalId: null,
      error: null,
      missing: request.missing,
    };

    if (request.missing.length > 0) {
      return { ...base, error: `missing configuration: ${request.missing.join(", ")}` };
    }
    // A dry run answers "what exactly would you send?" without creating a
    // record in the customer's CRM - the safe thing to click first.
    if (dryRun) return { ...base, ok: true };

    try {
      // The endpoint is whatever the org typed into the connector form - an
      // org admin could otherwise point this server's outbound request at its
      // own internal network or a cloud metadata endpoint. See ssrf-guard.ts.
      await assertPublicHttpUrl(request.url);
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const res = await fetch(request.url, {
        method: request.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-request-id": `aura-test-${integration.id}`,
          ...request.headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });

      const raw = await res.text().catch(() => "");
      let externalId: string | null = null;
      if (res.ok && integration.id_path) {
        try {
          const found = pluckPath(JSON.parse(raw), integration.id_path);
          if (found !== null && found !== undefined) externalId = String(found);
        } catch {
          // Non-JSON success body - the send worked, we just can't link it.
        }
      }

      return {
        ...base,
        ok: res.ok,
        status: res.status,
        responseBody: raw.slice(0, 4000),
        externalId,
        error: res.ok ? null : `receiver returned ${res.status}`,
      };
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private buildPayload(integration: IntegrationRow, source: Record<string, unknown>): unknown {
    const fieldMap = integration.field_map;
    const fields: Record<string, unknown> =
      !fieldMap || Object.keys(fieldMap).length === 0
        ? { event: "call.completed", call: { ...(source.call as object), facts: source.facts } }
        : Object.fromEntries(
            Object.entries(fieldMap).map(([dest, path]) => [dest, pluckPath(source, path)]),
          );

    const pairKeys = integration.pair_keys;
    return pruneBody(
      renderBody(integration.body_template ?? null, fields, integration.config ?? {}, {
        pairKeys: pairKeys && pairKeys.length === 2 ? [pairKeys[0], pairKeys[1]] : undefined,
      }),
    );
  }

  /**
   * Query-parameter auth (Pipedrive, LeadSquared) puts the credential in the
   * URL, and this URL is returned to the console and rendered on screen.
   */
  private redactQuerySecrets(url: string, secret: string | null): string {
    if (!secret) return url;
    return url.split(encodeURIComponent(secret)).join("***").split(secret).join("***");
  }

  /**
   * The field-map source document, minus the signed recording URL - presigning
   * needs the worker's S3 client, and a test does not need a playable link.
   */
  private async sourceForCall(
    client: { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> },
    callId: string,
  ): Promise<Record<string, unknown>> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
              c.remote_name, c.remote_number_prefix, c.remote_number_last3,
              c.remote_number_full,
              c.agent_id, c.agent_version, c.workspace_id,
              t.text AS transcript_text, t.language, t.intelligence, t.diarized,
              (SELECT jsonb_object_agg(f.field_key,
                        COALESCE(to_jsonb(f.value_num), to_jsonb(f.value_bool), to_jsonb(f.value_text)))
                 FROM call_facts f WHERE f.call_id = c.id) AS facts
         FROM calls c
         LEFT JOIN transcripts t ON t.call_id = c.id
        WHERE c.id = $1`,
      [callId],
    );
    const row = rows[0];
    if (!row) return syntheticSource();

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
        remoteNumber: row.remote_number_full,
        workspaceId: row.workspace_id,
      },
      facts: row.facts ?? {},
      transcript: {
        text: row.transcript_text,
        language: row.language,
        diarized: row.diarized,
      },
      intelligence: row.intelligence ?? {},
      meta: {
        instanceId: null,
        agentId: row.agent_id,
        agentVersion: row.agent_version,
        timestamp: new Date().toISOString(),
        confidenceScore: null,
        recordingUrl: null,
      },
    };
  }
}
