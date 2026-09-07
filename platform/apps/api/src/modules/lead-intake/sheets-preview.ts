import { BadRequestException } from "@nestjs/common";
import { decryptSecret, encryptSecret } from "@aura/db";
import { connectionProvider, sheetRange } from "@aura/shared";
import { refreshAccessToken } from "../connections/email-send";

/**
 * Read a spreadsheet's tab names and header row, so the console can offer a
 * column mapping instead of asking somebody to type their own headings.
 *
 * ── WHY THIS IS IN THE API AND THE SYNC IS IN THE WORKER ────────────────────
 *
 * They answer different questions. This one is interactive - a person has just
 * pasted a URL and is waiting - so it belongs on the request path. The sync is
 * a sweep over every tenant's sheets, so it belongs in the worker. Neither app
 * can import the other, and @aura/shared is deliberately network-free, so the
 * HTTP call is written twice. What is NOT written twice is the part that
 * decides meaning: `sheetRange` and the mapping helpers are shared, so the
 * preview and the sync can never disagree about which cells they are looking
 * at.
 *
 * ── IT READS THE HEADER ROW AND THREE ROWS UNDER IT ─────────────────────────
 *
 * The samples are what make a mapping obvious. "Column C is called Contact" is
 * ambiguous; "Column C is called Contact and the first value is
 * priya@example.com" is not, and it catches the common case of a sheet whose
 * headings do not describe its contents.
 */

export interface SheetPreview {
  spreadsheetId: string;
  title: string | null;
  tabs: string[];
  headers: string[];
  sampleRows: string[][];
}

interface AccountRow {
  id: string;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: Date | null;
  capabilities: string[];
}

type Client = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

/**
 * Resolve a token for the connection, refreshing when it has expired.
 *
 * The refreshed token is written back, so the interactive preview also fixes
 * the worker's next sweep rather than leaving it to discover the expiry again.
 */
async function accessTokenFor(
  client: Client,
  account: AccountRow,
  fetchImpl: typeof fetch,
): Promise<string> {
  let token = decryptSecret(account.access_token);
  const refresh = decryptSecret(account.refresh_token);
  const expired =
    account.token_expires_at !== null &&
    new Date(account.token_expires_at).getTime() < Date.now() + 60_000;

  if ((!token || expired) && refresh) {
    const spec = connectionProvider(account.provider);
    if (!spec) throw new BadRequestException("this connection's provider is not configured");
    const refreshed = await refreshAccessToken(spec, refresh, fetchImpl);
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
  if (!token) throw new BadRequestException("reconnect this Google account and try again");
  return token;
}

export async function previewSheet(
  client: Client,
  input: {
    connectedAccountId: string;
    spreadsheetId: string;
    sheetName?: string;
    headerRow?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<SheetPreview> {
  const { rows } = await client.query<AccountRow>(
    `SELECT id, provider, access_token, refresh_token, token_expires_at, capabilities
       FROM connected_accounts
      WHERE id = $1 AND status = 'active'`,
    [input.connectedAccountId],
  );
  const account = rows[0];
  if (!account) throw new BadRequestException("that Google connection was not found");
  // Named before the request, so the message says what to do. Google's own
  // refusal is "Request had insufficient authentication scopes", which nobody
  // outside this codebase can act on.
  if (!account.capabilities.includes("sheets")) {
    throw new BadRequestException(
      "this Google connection cannot read spreadsheets - reconnect it from Connections to grant that",
    );
  }

  const token = await accessTokenFor(client, account, fetchImpl);
  const auth = { authorization: `Bearer ${token}` };

  // Tab names first: without them a person has to know the exact spelling of
  // their own tab, and getting it wrong reads back as "the header row is
  // empty", which points at the wrong problem.
  const metaRes = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}?fields=properties.title,sheets.properties.title`,
    { headers: auth },
  );
  if (!metaRes.ok) {
    throw new BadRequestException(
      metaRes.status === 404
        ? "no spreadsheet with that link - check the URL, and that this Google account can open it"
        : `Google refused to open that spreadsheet (${metaRes.status})`,
    );
  }
  const meta = (await metaRes.json()) as {
    properties?: { title?: string };
    sheets?: Array<{ properties?: { title?: string } }>;
  };
  const tabs = (meta.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t));

  const headerRow = input.headerRow ?? 1;
  // The tab defaults to the first one, which is what somebody who has not
  // thought about tabs means.
  const tab = input.sheetName ?? tabs[0];
  const range = sheetRange(tab, headerRow).replace(":ZZ", `${headerRow + 3}:ZZ${headerRow + 3}`);

  const valuesRes = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    { headers: auth },
  );
  if (!valuesRes.ok) {
    throw new BadRequestException(
      valuesRes.status === 400
        ? `there is no tab called "${tab ?? ""}" in that spreadsheet`
        : `Google refused to read that tab (${valuesRes.status})`,
    );
  }
  const values = (await valuesRes.json()) as { values?: string[][] };
  const all = values.values ?? [];

  return {
    spreadsheetId: input.spreadsheetId,
    title: meta.properties?.title ?? null,
    tabs,
    headers: (all[0] ?? []).map((h) => String(h).trim()),
    sampleRows: all.slice(1, 4),
  };
}
