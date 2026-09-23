/**
 * The Integrations store's SQL, on its own so it can be run as it is.
 *
 * integrations.controller.ts sends these; verify-nav-and-store.cjs runs the
 * very same strings against a real Postgres, because typecheck cannot see
 * SQL - one wrong column name in a dozen-table batch 500s the store for every
 * tenant, and only a database says so.
 *
 * Constants only, every one of them. The batch is sent over the simple-query
 * protocol, which takes no bind parameters, so nothing caller-supplied may
 * ever appear here; RLS supplies the tenant, and the per-person filtering
 * (whose mailbox is whose) happens in integration-status.ts.
 */

/** The fixed part of the batch, in the order the controller destructures it. */
export const SNAPSHOT_SQL: readonly string[] = [
  `SELECT o.enabled_modules AS modules,
          COALESCE(
            (SELECT jsonb_object_agg(f.feature_key, f.enabled)
               FROM org_feature_settings f
              WHERE f.org_id = o.id),
            '{}'::jsonb) AS overrides
     FROM organizations o
    LIMIT 1`,

  // Every messaging channel. Personal ones are narrowed to the caller's own
  // in integration-status.ts, not here: the batch takes no parameters.
  `SELECT c.id, c.channel, c.provider, c.inbound_address, c.display_name, c.status,
          (c.api_key IS NOT NULL) AS has_api_key,
          (c.forward_secret IS NOT NULL) AS has_forward_secret,
          c.last_probe_at, c.last_probe_outcome, c.last_probe_detail, c.last_inbound_at,
          c.owner_user_id, c.created_at
     FROM messaging_channels c
    ORDER BY c.created_at`,

  `SELECT s.id, s.kind, s.name, s.provider, s.status, s.last_event_at, s.last_error,
          s.last_error_at, s.event_count, s.created_at,
          COALESCE(u.name, u.email) AS created_by
     FROM lead_sources s
     LEFT JOIN users u ON u.id = s.created_by_user_id
    ORDER BY s.created_at`,

  // 'connected' / 'revoked' - meta_connections (0063) uses the vocabulary
  // Meta itself does for a page grant. A revoked page is gone, not paused.
  `SELECT m.id, m.page_id, m.page_name, m.created_at, m.updated_at,
          COALESCE(u.name, u.email) AS connected_by
     FROM meta_connections m
     LEFT JOIN users u ON u.id = m.connected_by_user_id
    WHERE m.status = 'connected'
    ORDER BY m.created_at`,

  // The other way to Meta leads (0074), which the old hub never looked at -
  // an MCP-connected org read "not connected".
  `SELECT m.id, m.label, m.server_url, m.status, m.last_error, m.last_sync_at, m.created_at,
          COALESCE(u.name, u.email) AS created_by
     FROM mcp_connections m
     LEFT JOIN users u ON u.id = m.created_by_user_id
    WHERE m.provider = 'meta' AND m.status <> 'revoked'`,

  `SELECT l.id, l.account_urn, l.account_name, l.status, l.last_synced_at, l.sync_failures,
          l.last_error, l.created_at,
          COALESCE(u.name, u.email) AS connected_by
     FROM linkedin_connections l
     LEFT JOIN users u ON u.id = l.connected_by_user_id
    WHERE l.status <> 'revoked'
    ORDER BY l.created_at`,

  `SELECT a.id, a.user_id, a.provider, a.account_email, a.display_name, a.status,
          a.last_error, a.last_synced_at, a.created_at
     FROM connected_accounts a
    WHERE a.status <> 'revoked'
    ORDER BY a.created_at`,

  // Which gateways have keys - never the keys.
  `SELECT provider, enabled, (key_id IS NOT NULL) AS configured,
          (key_secret IS NOT NULL) AS has_secret, updated_at
     FROM payment_gateway_config`,

  // The organisation's own Google/Microsoft apps (0120). Which ones exist,
  // never what they hold.
  `SELECT provider FROM org_oauth_apps`,

  `SELECT id, provider, label, status, updated_at, created_at FROM crm_integrations`,

  `SELECT id, name, prefix, last_used_at, created_at
     FROM api_keys
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,

  // A Meta sign-in waiting for its page choice (0131). Expired rows are not
  // pending anything; the connect flow sweeps them.
  `SELECT id, provider, user_id, created_at
     FROM integration_pending_choices
    WHERE expires_at > now()`,
];

/** Which lead-source rows each lead-source app is made of. */
const SOURCE_KIND: Record<string, string> = {
  google_sheets: "s.kind = 'sheets'",
  web_forms: "s.kind IN ('web_form', 'email', 'api')",
  superfone: "s.kind = 'telephony' AND s.provider = 'superfone'",
  cti: "s.kind = 'telephony' AND s.provider <> 'superfone'",
};

/** Which audit actions tell each other app's story. */
const AUDIT_ACTIONS: Record<string, string> = {
  meta_lead_ads: "(a.action LIKE 'meta_connection.%' OR a.action LIKE 'mcp_connection.%')",
  linkedin_ads: "a.action LIKE 'linkedin_connection.%'",
  razorpay: "a.action = 'payment_gateway.update'",
  // Person apps: the caller's own rows are picked out in the controller.
  google_workspace: "a.action LIKE 'connection.%'",
  microsoft_365: "a.action LIKE 'connection.%'",
  smtp: "a.action LIKE 'connection.%'",
};

/**
 * An app's history: its audit rows, joined to its own provider rows, plus -
 * for the lead-source apps - the deliveries they turned away. Chosen by
 * catalogue id from the two tables above; nothing from the request.
 */
export function activityStatements(appId: string): string[] {
  const kind = SOURCE_KIND[appId];
  if (kind) {
    return [
      `SELECT a.created_at AS at, COALESCE(u.name, u.email) AS actor, a.actor_id, a.action,
              s.name AS target, NULL::text AS reason
         FROM audit_log a
         JOIN lead_sources s ON s.id::text = a.target_id
         LEFT JOIN users u ON u.id::text = a.actor_id
        WHERE a.action LIKE 'lead_source.%' AND ${kind}
        ORDER BY a.created_at DESC
        LIMIT 20`,
      `SELECT e.received_at AS at, NULL::text AS actor, NULL::text AS actor_id,
              'intake.' || e.outcome AS action, s.name AS target, e.reason
         FROM lead_intake_events e
         JOIN lead_sources s ON s.id = e.source_id
        WHERE ${kind} AND e.outcome IN ('rejected', 'error')
        ORDER BY e.received_at DESC
        LIMIT 10`,
    ];
  }

  const where = AUDIT_ACTIONS[appId];
  if (!where) return [];
  return [
    `SELECT a.created_at AS at, COALESCE(u.name, u.email) AS actor, a.actor_id, a.action,
            NULL::text AS target, NULL::text AS reason
       FROM audit_log a
       LEFT JOIN users u ON u.id::text = a.actor_id
      WHERE ${where}
      ORDER BY a.created_at DESC
      LIMIT 20`,
  ];
}
