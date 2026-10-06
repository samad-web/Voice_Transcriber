"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";
import { errorText } from "../../actions";
import {
  MAX_CELL_CHARS,
  UPLOAD_CHUNK,
  summariseChunk,
  type DncAddEntriesResponse,
  type DncChunkSummary,
} from "./upload-summary";

/**
 * Settings → Calls & AI → Do-not-call lists (migration 0158, Build docs/39 §4.2).
 *
 * Three routes, and the one that is missing. `dnc.controller.ts` offers
 * `GET /dnc/lists`, `POST /dnc/lists`, `POST /dnc/lists/:id/entries` and
 * `PATCH /dnc/lists/:id` - and deliberately NO delete, because deleting a list
 * re-opens every number on it for dialling with nothing left to say they were
 * ever closed. There is no delete action in this file and there must not be
 * one; retiring a list is `setDncListStatusAction(id, "disabled")`.
 *
 * The persona check is not here. Every route carries
 * `@RequireCrmPermission("dnc", …)`, and `create`/`edit` are seeded to the
 * three admin roles only while `view` reaches everybody - this tier forwards a
 * verified session and reads the refusal back. The org is never passed in:
 * `orgHeaders` re-derives it from the session, so a caller can send whatever
 * they like and still only write inside their own tenant.
 */

const PAGE = "/owner/settings/suppression";

/**
 * Mirrors `CreateListBody` in dnc.controller.ts.
 *
 * A copy, because the API keeps its schema in the controller and
 * `packages/shared` carries no DNC types. The API is still what validates; this
 * is here so an empty name costs a keystroke rather than a round trip. Note
 * `kind` has NO default on either side, on purpose: 0158 makes regulatory vs
 * internal the fact a compliance question is answered with, and defaulting it
 * would answer that question on the uploader's behalf.
 */
const CreateList = z.object({
  name: z.string().trim().min(1, "Name this list.").max(120, "Use at most 120 characters."),
  kind: z.enum(["regulatory", "internal"]),
});

/** Mirrors `UpdateListBody`'s status half - the only half this screen sends. */
const SetStatus = z.object({
  listId: z.string().uuid(),
  status: z.enum(["active", "disabled"]),
});

const AddEntries = z.object({
  listId: z.string().uuid(),
  // `.max(UPLOAD_CHUNK)` is the API's own per-request cap. A caller that sent
  // more would be refused by the route anyway, with a validation error instead
  // of a sentence - see upload-summary.ts on why one over-long body loses the
  // per-row report for every good number beside it.
  numbers: z.array(z.string().max(MAX_CELL_CHARS)).min(1).max(UPLOAD_CHUNK),
});

/**
 * A list as `GET /dnc/lists` returns it.
 *
 * `kind` and `status` are `string` and not unions, although the column has a
 * CHECK behind it. The console renders both through a lookup with a fallback,
 * so a value added to the CHECK in a later migration shows up as itself rather
 * than as a blank cell that a type assertion promised could not exist.
 */
export interface DncList {
  id: string;
  name: string;
  /** 'regulatory' - somebody else's registry; 'internal' - the tenant's own. */
  kind: string;
  /** 'active' | 'disabled'. */
  status: string;
  entryCount: number;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

/**
 * What the reader may do, answered by `GET /dnc/lists` rather than guessed
 * here.
 *
 * 0158 seeds `dnc:view` to every system role - including `viewer`, because the
 * dialer's agent screen renders "on a DNC list" as a block reason - but
 * `dnc:create`/`dnc:edit` to the three admin roles only, and both halves are
 * regrantable per role on Team & permissions. So a reader of this page is not
 * necessarily a writer of it, and the persona the page is gated on cannot say
 * which. The route reads the grid and tells us.
 */
export interface DncGrants {
  create: boolean;
  edit: boolean;
}

/**
 * What `POST /dnc/lists` and `PATCH /dnc/lists/:id` both answer with - five
 * fields, and NOT the row the list page renders: neither carries
 * `uploadedByName` or `createdAt`. Both actions therefore revalidate the page
 * and the caller refreshes, rather than splicing a half-row into the table.
 */
export interface DncListStub {
  id: string;
  name: string;
  kind: string;
  status: string;
  entryCount: number;
}

/**
 * The API's refusal, in words an owner can act on.
 *
 * 403 gets its own sentence because the API's is "Forbidden resource", and the
 * reader here is an administrator of their own workspace who needs to know it
 * is their ROLE and not the page. Everything else keeps the API's own message:
 * `ConflictException({ code: "list_disabled", … })` puts a usable sentence in
 * `message` ("…is disabled. Re-enable it before adding numbers."), and a zod
 * failure arrives as an issue array that `errorText` already flattens.
 */
async function refusal(res: Response): Promise<string> {
  if (res.status === 403) {
    return "Your role cannot change do-not-call lists. Ask an owner of this workspace.";
  }
  return errorText(res);
}

/**
 * The one fetch the three actions below make.
 *
 * Not exported, so this file's public surface stays the three pinned
 * method/path pairs: a generic `(method, path, body)` exported from a
 * `"use server"` module would be a public endpoint reaching any owner route
 * with this session's credentials - the trap lib/attendance-api.ts documents.
 */
async function dncCall<T>(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<{ data?: T; error?: string }> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in to a workspace." };
  const headers = orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch {
    return { error: "The server could not be reached. Try again in a moment." };
  }
  if (!res.ok) return { error: await refusal(res) };
  return { data: (await res.json()) as T };
}

export interface CreateListResult {
  error?: string;
  list?: DncListStub;
}

/** A new, empty list. Numbers go in through `addDncEntriesAction`. */
export async function createDncListAction(input: unknown): Promise<CreateListResult> {
  const parsed = CreateList.safeParse(input);
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Check the list details." };

  const result = await dncCall<{ list: DncListStub }>("POST", "/v1/dnc/lists", parsed.data);
  if (result.error) return { error: result.error };
  revalidatePath(PAGE);
  return { list: result.data?.list };
}

export interface AddEntriesResult {
  error?: string;
  chunk?: DncChunkSummary;
}

/**
 * Append one chunk of a sheet to a list.
 *
 * One chunk, not one upload: the route caps a request at `UPLOAD_CHUNK` cells,
 * and because every chunk reconciles `entry_count` from `count(*)` rather than
 * adding its own total, the number is right after the last one whatever order
 * they land in. The caller loops and adds the answers up (`mergeChunk`).
 */
export async function addDncEntriesAction(
  listId: unknown,
  numbers: unknown,
): Promise<AddEntriesResult> {
  const parsed = AddEntries.safeParse({ listId, numbers });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Those numbers could not be sent." };
  }

  const result = await dncCall<DncAddEntriesResponse>(
    "POST",
    `/v1/dnc/lists/${parsed.data.listId}/entries`,
    { numbers: parsed.data.numbers },
  );
  if (result.error || !result.data)
    return { error: result.error ?? "The upload did not complete." };
  revalidatePath(PAGE);
  return { chunk: summariseChunk(result.data) };
}

export interface SetStatusResult {
  error?: string;
  list?: DncListStub;
}

/**
 * Retire a list, or bring it back.
 *
 * This is the whole of what `PATCH /dnc/lists/:id` is used for here. The route
 * can also rename, and that is left off deliberately: a suppression list's name
 * is what an audit row and a block reason refer to it by, and nothing on this
 * screen needs it changed.
 */
export async function setDncListStatusAction(
  listId: unknown,
  status: unknown,
): Promise<SetStatusResult> {
  const parsed = SetStatus.safeParse({ listId, status });
  if (!parsed.success) return { error: "Choose active or disabled." };

  const result = await dncCall<{ list: DncListStub }>(
    "PATCH",
    `/v1/dnc/lists/${parsed.data.listId}`,
    { status: parsed.data.status },
  );
  if (result.error) return { error: result.error };
  revalidatePath(PAGE);
  return { list: result.data?.list };
}
