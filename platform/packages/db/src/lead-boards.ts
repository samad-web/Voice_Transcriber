import {
  LeadBoardChannel,
  MAIN_LEAD_BOARD_NAME,
  parseLeadStages,
  type LeadStages,
} from "@aura/shared";
import type { DbClient } from "./crm-projection";

/**
 * Which lead board a lead is on, and what that board's columns are (0136).
 *
 * The Main board is the org's original one: it has no `lead_boards` row, its
 * columns are `organizations.lead_stages`, and its leads carry
 * `board_id IS NULL`. Every other board is a row with its own `stages`. These
 * two functions are the only place that difference is spelled out - a caller
 * asks for a board's stages, or for where a new lead should go, and never
 * writes `WHERE board_id IS NULL` logic of its own.
 */

export interface LeadBoardInfo {
  /** null for the Main board. */
  id: string | null;
  name: string;
  stages: LeadStages;
}

/** A board's name and columns, or null when `boardId` is not a board of this org. */
export async function leadBoardStages(
  client: DbClient,
  orgId: string,
  boardId: string | null,
): Promise<LeadBoardInfo | null> {
  if (boardId === null) {
    const {
      rows: [org],
    } = await client.query<{ lead_stages: unknown; main_lead_board_name: string | null }>(
      "SELECT lead_stages, main_lead_board_name FROM organizations WHERE id = $1",
      [orgId],
    );
    if (!org) return null;
    return { id: null, name: org.main_lead_board_name ?? MAIN_LEAD_BOARD_NAME, stages: parseLeadStages(org.lead_stages) };
  }

  const {
    rows: [board],
  } = await client.query<{ id: string; name: string; stages: unknown }>(
    "SELECT id, name, stages FROM lead_boards WHERE id = $1::uuid AND org_id = $2",
    [boardId, orgId],
  );
  return board ? { id: board.id, name: board.name, stages: parseLeadStages(board.stages) } : null;
}

/** Every board of the org, the Main board first, then in the order the owner set. One round trip. */
export async function listLeadBoards(client: DbClient, orgId: string): Promise<LeadBoardInfo[]> {
  const { rows } = await client.query<{ id: string | null; name: string | null; stages: unknown }>(
    `SELECT id, name, stages FROM (
       SELECT NULL::uuid AS id, main_lead_board_name AS name, lead_stages AS stages,
              -1 AS sort_order, ''::text AS sort_name
         FROM organizations WHERE id = $1
       UNION ALL
       SELECT id, name, stages, sort_order, lower(name)
         FROM lead_boards WHERE org_id = $1
     ) b
     ORDER BY sort_order, sort_name`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.id === null ? (r.name ?? MAIN_LEAD_BOARD_NAME) : (r.name ?? ""),
    stages: parseLeadStages(r.stages),
  }));
}

export interface LeadBoardRouteQuery {
  /** The lead's source_channel. Anything but whatsapp/web_form/manual is never routed. */
  channel: string | null | undefined;
  /** The messaging_channels.id (WhatsApp) or lead_sources.id (web form) it came through. */
  sourceId?: string | null;
}

/**
 * The board a NEW lead from this channel goes to: the route for its exact
 * source, else the route for the whole channel, else null - the Main board.
 *
 * Inside a savepoint, and a failure answers null rather than throwing. The
 * callers run this inside the transaction that writes the lead - a web-form
 * webhook, a WhatsApp approval - and a routing lookup that aborted it would
 * lose the lead itself. Landing on the Main board is always a correct outcome;
 * losing the enquiry never is.
 */
export async function resolveLeadBoard(
  client: DbClient,
  orgId: string,
  { channel, sourceId }: LeadBoardRouteQuery,
): Promise<string | null> {
  if (!LeadBoardChannel.safeParse(channel).success) return null;

  await client.query("SAVEPOINT lead_board_route");
  try {
    const {
      rows: [route],
    } = await client.query<{ board_id: string | null }>(
      // `source_id = NULL` is never true, so a null source only ever matches
      // the channel-wide route. The exact-source row sorts first - including
      // one whose board is NULL, which is "the Main board" said explicitly and
      // must beat a channel-wide route to somewhere else.
      `SELECT board_id FROM lead_board_routes
        WHERE org_id = $1 AND channel = $2
          AND (source_id = $3::uuid OR source_id IS NULL)
        ORDER BY (source_id IS NULL)
        LIMIT 1`,
      [orgId, channel, sourceId ?? null],
    );
    await client.query("RELEASE SAVEPOINT lead_board_route");
    return route?.board_id ?? null;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT lead_board_route");
    console.error(`lead board routing failed for org ${orgId} (lead goes to the Main board):`, err);
    return null;
  }
}
