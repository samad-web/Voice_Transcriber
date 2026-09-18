import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, getAdminPool, withOrgContext } from "@aura/db";
import {
  LeadSourceConfig,
  normalizeIntake,
  phoneDigits,
  sheetFieldMap,
  sheetRange,
  sheetRowToPayload,
  featureSpec,
  sheetsConfigured,
} from "@aura/shared";
import type { DbClient } from "./crm-dispatch";
import { ingestIntakeLead, type IntakeSourceRow } from "./lead-intake";
import { oauthAppFor, refreshAccessToken } from "./email-sync";
import { ProviderHttpError } from "./email-providers";

/** The catalogue entry this sweep is gated on - see the org query below. */
const SHEETS_FEATURE = featureSpec("sheets_sync");

/**
 * Google Sheets as a lead source (migration 0096).
 *
 * ── WHY POLLED, AND WHY THAT IS FINE ────────────────────────────────────────
 *
 * Sheets has no push notification worth having for this (its watch API needs a
 * publicly reachable webhook per file and expires every few days), so this is
 * a sweep - the same shape as the LinkedIn poller next door. A lead that
 * arrives in a spreadsheet is minutes old by definition: somebody typed it, or
 * a partner pasted a block of them. Five-minute latency is not the constraint.
 *
 * ── THE WATERMARK IS A SHORTCUT, NOT THE CORRECTNESS MECHANISM ──────────────
 *
 * `sync_state.lastRowSynced` decides which rows to ASK Google for. It cannot
 * decide which rows are new, because a spreadsheet is not an append-only log:
 * people insert rows in the middle, sort by name, and delete the ones they have
 * called. Any of those shifts every row number below, and a watermark alone
 * would then re-import a block of leads or skip one.
 *
 * So the actual idempotency is `lead_intake_events`' unique
 * `(source_id, external_id)`, and the external id is derived from the ROW'S
 * OWN IDENTITY - the phone number, or the email, or failing both the name and
 * position. Re-reading a row is therefore free, which is what lets the
 * watermark be a performance optimisation that is allowed to be wrong.
 *
 * ── AND WHY IT DOES NOT IMPORT HISTORY BY DEFAULT ───────────────────────────
 *
 * Connecting a sheet that has held three thousand rows since last year would
 * otherwise create three thousand leads dated today and put every one in front
 * of somebody as new work. First sync sets the watermark to the bottom of the
 * sheet and imports nothing, unless `config.importExisting` says otherwise.
 * That is stated on the console's own panel, because it is the one thing about
 * this connector that surprises people.
 */

/** Rows imported per source per tick. Bounds a backfill's blast radius. */
const MAX_ROWS = Number(process.env.SHEETS_SYNC_MAX_ROWS ?? 200);
/** Consecutive failures before a source stops being polled. Same as mail/calendar. */
const MAX_FAILURES = 5;

interface SourceRow extends IntakeSourceRow {
  org_id: string;
  name: string;
  config: unknown;
  sync_state: { lastRowSynced?: number; headerFingerprint?: string } | null;
  error_count: string | number;
}

interface AccountRow {
  id: string;
  org_id: string;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: Date | null;
  capabilities: string[];
  oauth_client_id: string | null;
}

interface SheetValues {
  headers: string[];
  rows: string[][];
  /** 1-based sheet row number of `rows[0]`. */
  firstRowNumber: number;
}

/**
 * The identity this row will be claimed under.
 *
 * Phone first because it is the field an Indian SMB's sheet always has and the
 * one `leads` already dedupes on; email second; and only when neither exists
 * does position enter it - at which point the row is genuinely indistinguishable
 * from a re-typed copy of itself, and treating the position as part of the
 * identity is the least wrong of the available answers.
 *
 * Hashed rather than stored raw, for the same reason `calls` never holds a full
 * number: `lead_intake_events.external_id` is a plain column, and a phone
 * number in it would be a second, unencrypted copy of the thing the rest of the
 * schema goes to some trouble not to keep.
 */
export function sheetRowIdentity(
  phone: string | null,
  email: string | null,
  name: string | null,
  rowNumber: number,
): string {
  const basis =
    phoneDigits(phone ?? "") || email?.trim().toLowerCase() || `${rowNumber}:${name ?? ""}`;
  return createHash("sha256").update(`sheet:${basis}`).digest("hex").slice(0, 40);
}

/** A stable summary of the header row, so a re-arranged sheet is detectable. */
export function headerFingerprint(headers: string[]): string {
  return createHash("sha256")
    .update(headers.map((h) => h.trim().toLowerCase()).join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Read the header row and the rows after the watermark, in one HTTP call.
 *
 * `batchGet` with two ranges rather than one range from the top: a sheet with
 * four thousand rows would otherwise be re-transferred every five minutes to
 * find the two that are new. The header comes back every time regardless,
 * because it is what the fingerprint check compares.
 */
export async function fetchSheet(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string | undefined,
  headerRow: number,
  fromRow: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SheetValues> {
  const headerRange = sheetRange(sheetName, headerRow).replace(
    ":ZZ",
    `${headerRow}:ZZ${headerRow}`,
  );
  const dataRange = sheetRange(sheetName, fromRow);
  const params = new URLSearchParams();
  params.append("ranges", headerRange);
  params.append("ranges", dataRange);
  params.set("majorDimension", "ROWS");
  // FORMATTED_VALUE, not UNFORMATTED: a phone number typed into a spreadsheet
  // is displayed as text and stored as whatever Google guessed. Unformatted
  // gives 9.8765e+9 for a mobile number, which is not a phone number any more.
  params.set("valueRenderOption", "FORMATTED_VALUE");

  const res = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ProviderHttpError(res.status, detail.slice(0, 300));
  }
  const body = (await res.json()) as {
    valueRanges?: Array<{ values?: string[][] }>;
  };
  return {
    headers: body.valueRanges?.[0]?.values?.[0] ?? [],
    rows: body.valueRanges?.[1]?.values ?? [],
    firstRowNumber: fromRow,
  };
}

/**
 * Resolve a usable access token for the connection, refreshing if needed.
 *
 * Lifted in shape from calendar-sync.ts rather than shared with it: that
 * function also writes calendar cursors and failure counters, and the part
 * worth reusing is `refreshAccessToken`, which is.
 */
async function accessTokenFor(
  client: DbClient,
  account: AccountRow,
  fetchImpl: typeof fetch,
): Promise<string> {
  let token = decryptSecret(account.access_token);
  const refresh = decryptSecret(account.refresh_token);
  const expired =
    account.token_expires_at !== null && account.token_expires_at.getTime() < Date.now() + 60_000;

  if ((!token || expired) && refresh) {
    const app = await oauthAppFor(client, account);
    const refreshed = await refreshAccessToken(app, refresh, fetchImpl);
    token = refreshed.accessToken;
    await client.query(
      `UPDATE connected_accounts
          SET access_token = $2,
              token_expires_at = CASE WHEN $3::int IS NULL THEN NULL
                                      ELSE now() + make_interval(secs => $3::int) END
        WHERE id = $1`,
      [account.id, encryptSecret(refreshed.accessToken), refreshed.expiresIn],
    );
  }
  if (!token) throw new Error("the Google connection has no usable token - reconnect it");
  return token;
}

/** Write a readable failure onto the source, where the person configuring it looks. */
async function recordError(client: DbClient, sourceId: string, message: string): Promise<void> {
  await client.query(
    `UPDATE lead_sources
        SET error_count = error_count + 1, last_error = $2, last_error_at = now()
      WHERE id = $1`,
    [sourceId, message.slice(0, 500)],
  );
}

/**
 * One source, one pass.
 *
 * Returns how many leads it created. Exported for the integration test and for
 * the console's "sync now" path.
 */
export async function syncSheetSource(
  client: DbClient,
  source: SourceRow,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const parsed = LeadSourceConfig.safeParse(source.config ?? {});
  if (!parsed.success || !sheetsConfigured(parsed.data)) {
    await recordError(client, source.id, "this sheet is not finished being set up");
    return 0;
  }
  const config = parsed.data;
  const headerRow = config.headerRow ?? 1;

  const {
    rows: [account],
  } = await client.query<AccountRow>(
    `SELECT id, org_id, provider, access_token, refresh_token, token_expires_at, capabilities,
            oauth_client_id
       FROM connected_accounts
      WHERE id = $1 AND status = 'active'`,
    [config.connectedAccountId],
  );
  if (!account) {
    await recordError(client, source.id, "the Google account this sheet reads through is gone");
    return 0;
  }
  // Checked before the request rather than after the 403, so the message says
  // what to do. A connection made before this connector existed genuinely
  // lacks the scope, and only reconnecting can add it.
  if (!account.capabilities.includes("sheets")) {
    await recordError(
      client,
      source.id,
      "this Google connection was not authorised to read spreadsheets - reconnect it from Connections",
    );
    return 0;
  }

  const token = await accessTokenFor(client, account, fetchImpl);
  const watermark = source.sync_state?.lastRowSynced ?? null;
  const fromRow = watermark === null ? headerRow + 1 : watermark + 1;

  const sheet = await fetchSheet(
    token,
    config.spreadsheetId!,
    config.sheetName,
    headerRow,
    fromRow,
    fetchImpl,
  );

  if (sheet.headers.length === 0) {
    await recordError(client, source.id, "the header row is empty - check the tab name");
    return 0;
  }

  // ── The header check ──────────────────────────────────────────────────────
  //
  // A column mapping is keyed on header text, so a renamed or re-ordered
  // header means the mapping no longer describes the sheet. Importing anyway
  // would put email addresses in the name field and phone numbers nowhere,
  // silently, for as long as nobody looked. Stopping is the correct failure:
  // the leads are still in the sheet and can be imported once the mapping is
  // fixed, whereas a thousand mis-parsed leads cannot be un-created.
  const fingerprint = headerFingerprint(sheet.headers);
  const known = source.sync_state?.headerFingerprint;
  if (known && known !== fingerprint) {
    await recordError(
      client,
      source.id,
      "the columns in this sheet changed - open it here and check the mapping before syncing again",
    );
    await client.query(`UPDATE lead_sources SET status = 'paused' WHERE id = $1`, [source.id]);
    return 0;
  }

  // ── First sync ────────────────────────────────────────────────────────────
  if (watermark === null && !config.importExisting) {
    const bottom = headerRow + sheet.rows.length;
    await client.query(
      `UPDATE lead_sources
          SET sync_state = jsonb_build_object(
                'lastRowSynced', $2::int,
                'headerFingerprint', $3::text,
                'lastSyncAt', to_jsonb(now())),
              last_error = NULL, last_error_at = NULL
        WHERE id = $1`,
      [source.id, bottom, fingerprint],
    );
    console.log(
      `sheets: ${source.name} - watching from row ${bottom + 1}, existing rows left alone`,
    );
    return 0;
  }

  const fieldMap = sheetFieldMap(config.columnMapping ?? {}, sheet.headers);
  const batch = sheet.rows.slice(0, MAX_ROWS);
  let created = 0;
  let lastRow = fromRow - 1;

  for (let i = 0; i < batch.length; i++) {
    const rowNumber = sheet.firstRowNumber + i;
    lastRow = rowNumber;
    const payload = sheetRowToPayload(sheet.headers, batch[i]);
    // A blank row in the middle of a sheet is a spacer, not a lead.
    if (Object.keys(payload).length === 0) continue;

    // The mapping is handed over as a `fieldMap` OVERRIDE rather than as the
    // provider's own map, because the sheets provider deliberately ships an
    // empty one: a spreadsheet's shape is whatever the customer typed at the
    // top of their columns, and there is no default worth guessing.
    const intake = normalizeIntake("sheets", "google", payload, { fieldMap });
    const externalId = sheetRowIdentity(intake.phone, intake.email, intake.name, rowNumber);

    const outcome = await ingestIntakeLead(client, source.org_id, "sheets", source, {
      externalId,
      name: intake.name,
      email: intake.email,
      phone: intake.phone,
      company: intake.company,
      notes: intake.notes,
      text: intake.text,
      occurredAt: intake.occurredAt ? new Date(intake.occurredAt) : null,
      facts: intake.facts,
      raw: payload,
    });
    if (outcome === "created") created++;
  }

  await client.query(
    `UPDATE lead_sources
        SET sync_state = jsonb_build_object(
              'lastRowSynced', $2::int,
              'headerFingerprint', $3::text,
              'lastSyncAt', to_jsonb(now())),
            error_count = 0, last_error = NULL, last_error_at = NULL
      WHERE id = $1`,
    [source.id, lastRow, fingerprint],
  );
  return created;
}

/** One pass over every configured sheet on the platform. */
export async function runSheetsSync(fetchImpl: typeof fetch = fetch): Promise<number> {
  const { rows: sources } = await getAdminPool().query<SourceRow>(
    `SELECT s.id, s.org_id, s.name, s.config, s.sync_state, s.status, s.error_count,
            s.workspace_id, s.marketing_source_id, s.project_id, s.assigned_telecaller_id
       FROM lead_sources s
       JOIN organizations o ON o.id = s.org_id AND o.status = 'active'
      WHERE s.kind = 'sheets' AND s.status = 'active' AND s.error_count < $1
        -- The client's own switch (0101). A source stays configured and its
        -- watermark stays put; the poller simply stops.
        --
        -- THIS IS THE GATE THAT MATTERS. Hiding the panel would leave the
        -- worker importing rows every ten minutes into a console that no
        -- longer shows where they came from - "I turned Google Sheets off and
        -- leads kept appearing" is the bug report, and no amount of nav
        -- filtering prevents it. A background sweep has to be told.
        --
        -- The default and the module come from the catalogue rather than being
        -- written here, so the two never disagree - see features.ts.
        AND org_feature_enabled(o.id, $2, $3, $4)
      ORDER BY s.updated_at
      LIMIT 50`,
    [MAX_FAILURES, SHEETS_FEATURE.key, SHEETS_FEATURE.module, SHEETS_FEATURE.defaultEnabled],
  );
  if (sources.length === 0) return 0;

  let created = 0;
  for (const source of sources) {
    try {
      created += await withOrgContext(source.org_id, (client) =>
        syncSheetSource(client as DbClient, source, fetchImpl),
      );
    } catch (err) {
      // The error is recorded ON THE SOURCE as well as logged, because the
      // person who can fix it - "the sheet was moved to another Drive" - reads
      // the lead-sources page, not the worker's stdout.
      const message =
        err instanceof ProviderHttpError
          ? `Google said ${err.status}`
          : err instanceof Error
            ? err.message
            : String(err);
      console.error(`sheets sync: source ${source.id}:`, err);
      await withOrgContext(source.org_id, (client) =>
        recordError(client as DbClient, source.id, message),
      ).catch(() => undefined);
    }
  }
  if (created > 0) console.log(`sheets sync: created ${created} lead(s)`);
  return created;
}

/**
 * Always on. It used to stay off unless the PLATFORM had a Google OAuth app,
 * but organisations now bring their own (migration 0120), so the deployment's
 * environment says nothing about whether any tenant can sync. It costs nothing
 * when idle: a sheet source can only exist after somebody connected a Google
 * account, which needed an app to begin with, and a source whose app has since
 * gone records that on itself rather than failing silently.
 */
export function startSheetsSync(): NodeJS.Timeout | null {
  const interval = Number(process.env.SHEETS_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runSheetsSync()
      .catch((err) => console.error("sheets sync:", err))
      .finally(() => {
        running = false;
      });
  }, interval);
}
