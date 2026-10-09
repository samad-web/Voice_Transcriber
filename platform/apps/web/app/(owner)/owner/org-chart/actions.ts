"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AssignInput,
  AuthorityInput,
  ContractDocumentInput,
  ContractInput,
  CreatePositionInput,
  DottedLineInput,
  MovePositionInput,
  OrgChartSettingsInput,
  ResponsibilitiesInput,
  SkillsInput,
  UnassignInput,
  UpdateContractInput,
  UpdatePositionInput,
} from "@aura/shared";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";
import type {
  ContractAccessEntry,
  ContractDocumentView,
  ContractView,
  ProfilePayload,
} from "./types";

/**
 * The organization chart's writes (Build docs/org-chart-build-plan.md §8).
 *
 * ── THE SCHEMAS ARE IMPORTED, NOT COPIED ───────────────────────────────────
 *
 * Every other console page in this repo re-declares its bodies as local zod
 * objects, because the API keeps its own in its controller. This module's live
 * in `@aura/shared` (`CreatePositionInput`, `MovePositionInput`, …) and the API
 * imports the SAME objects - so there is exactly one definition of what a move
 * is, and a bound tightened in one place cannot drift from the other.
 *
 * That matters more here than it would for a resource code. §4.3's integrity
 * rules are partly expressed in these schemas - a move REQUIRES an effective
 * date, `UpdatePositionInput` has no `managerPositionId`, a contract may not
 * be created `expiring` - and a console copy that quietly diverged would be a
 * second, weaker set of rules in front of the real ones.
 *
 * The API still validates. These exist to turn a mistake into a sentence next
 * to the field instead of a round trip.
 */

const PAGE = "/owner/org-chart";

type Refusal = { error: string };
type Ok<T> = { data: T };
export type ActionResult<T = Record<string, unknown>> = { error?: string; data?: T };

async function refusal(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    const m = body.message;
    if (typeof m === "string") return m;
    if (Array.isArray(m)) {
      const first = m[0] as { message?: unknown } | undefined;
      if (first && typeof first.message === "string") return first.message;
    }
  } catch {
    // Non-JSON body: a proxy or a crash, not a refusal with something to say.
  }
  /**
   * The API's own 409 messages are the useful ones here and are passed through
   * above - "Head of Sales reports to Sales Rep, so…", "This chart already has
   * a top position". They name the two positions involved and what to do, which
   * a generic string cannot.
   *
   * 403 is worth replacing, because the API's is a bare "Forbidden" and the
   * reason is almost always the same one: reshaping the organization is
   * owner/admin work by default (§14).
   */
  if (res.status === 403) {
    return "You do not have permission to change the organization chart. An owner can grant it on Team & permissions.";
  }
  if (res.status === 404) return "That position is no longer there. Reload the chart.";
  return `That didn't save (${res.status}).`;
}

async function call<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Refusal | Ok<T>> {
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { error: "The server could not be reached. Try again in a moment." };
  }
  if (!res.ok) return { error: await refusal(res) };
  const text = await res.text();
  return { data: (text ? JSON.parse(text) : {}) as T };
}

/** Everything a drawer needs for one seat, fetched when it opens (§12: lazily). */
export async function fetchPositionAction(
  id: unknown,
  asOf?: unknown,
): Promise<ActionResult<ProfilePayload>> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const query = typeof asOf === "string" && asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  const result = await call<ProfilePayload>("GET", `/v1/org-chart/positions/${id}${query}`);
  if ("error" in result) return result;
  return { data: result.data };
}

/**
 * §6.3's Contract tab, for whoever holds the position.
 *
 * A separate request from the profile, deliberately - see the API's own note
 * on `GET /org-chart/positions/:id`. The profile route is callable by every
 * persona, so folding a contract into it would put the decision "may this
 * reader see a salary" inside a read that is otherwise unrestricted. Here, a
 * reader without `employment_contract:view` gets a 403 and the tab shows
 * nothing, which is §6.4's rule applied to §6.3.
 *
 * Returns `{}` rather than an error on a refusal, because a 403 here is the
 * NORMAL case for most of the console's users and is not something to put a
 * red banner in front of. The tab is only rendered for readers the page
 * already believes may see it; this is the belt to that braces.
 */
export async function fetchContractAction(
  userId: unknown,
): Promise<ActionResult<{ contract: ContractView | null }>> {
  if (typeof userId !== "string" || !userId) return { data: { contract: null } };
  const result = await call<{ contracts: ContractView[] }>(
    "GET",
    `/v1/org-chart/contracts?userId=${encodeURIComponent(userId)}`,
  );
  if ("error" in result) return { data: { contract: null } };
  /**
   * The ACTIVE one, or the most recent if there is none.
   *
   * The list is ordered by status then end date, and a person has at most one
   * active contract (0178's partial unique index). A draft for next year
   * sitting alongside is legitimate, and showing the draft as though it were
   * in force would misstate somebody's notice period.
   */
  const rows = result.data.contracts ?? [];
  const active = rows.find((row) => row.status === "active" || row.status === "expiring");
  return { data: { contract: active ?? rows[0] ?? null } };
}

export async function createPositionAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = CreatePositionInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call<{ id: string }>("POST", "/v1/org-chart/positions", parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { data: result.data };
}

export async function updatePositionAction(id: unknown, patch: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const parsed = UpdatePositionInput.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call("PATCH", `/v1/org-chart/positions/${id}`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

/**
 * §5.2's drag-and-drop, behind a confirm dialog.
 *
 * The effective date and the reason are REQUIRED by the schema rather than
 * defaulted here, which is what makes the confirm dialog unavoidable: a drop
 * cannot become a write without somebody answering "from when". §5.2 asks for
 * exactly that dialog, and defaulting the date to today in this file would
 * have made the dialog skippable and the history wrong.
 */
export async function movePositionAction(id: unknown, input: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const parsed = MovePositionInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Pick a date for the move." };
  const result = await call("POST", `/v1/org-chart/positions/${id}/move`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

export async function deletePositionAction(
  id: unknown,
  options?: unknown,
): Promise<ActionResult<{ promoted: number }>> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const parsed = z
    .object({ promoteReports: z.boolean().optional(), reason: z.string().trim().max(500).optional() })
    .safeParse(options ?? {});
  if (!parsed.success) return { error: "Check the details." };
  const query = new URLSearchParams();
  if (parsed.data.promoteReports) query.set("promoteReports", "1");
  if (parsed.data.reason) query.set("reason", parsed.data.reason);
  const suffix = query.toString() ? `?${query}` : "";
  const result = await call<{ promoted: number }>(
    "DELETE",
    `/v1/org-chart/positions/${id}${suffix}`,
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { data: result.data };
}

export async function assignPositionAction(id: unknown, input: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const parsed = AssignInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Choose somebody." };
  const result = await call("POST", `/v1/org-chart/positions/${id}/assign`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

export async function unassignPositionAction(id: unknown, input: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const parsed = UnassignInput.safeParse(input ?? {});
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call("POST", `/v1/org-chart/positions/${id}/unassign`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

/**
 * §6.2's responsibilities editor, with §14's manager route as a fallback.
 *
 * Tries the admin route first and falls back to `/as-manager` on a 403, rather
 * than asking the caller which they are. The alternative - the console
 * deciding - would mean the browser held an opinion about somebody's
 * permissions, and the first time a grant changed mid-session it would be
 * wrong. Both routes re-authorize server-side; this only picks which 403 the
 * person is shown.
 */
export async function setResponsibilitiesAction(
  id: unknown,
  input: unknown,
): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const parsed = ResponsibilitiesInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };

  const asAdmin = await call("PUT", `/v1/org-chart/positions/${id}/responsibilities`, parsed.data);
  if (!("error" in asAdmin)) {
    revalidatePath(PAGE);
    return {};
  }
  const asManager = await call(
    "PUT",
    `/v1/org-chart/positions/${id}/responsibilities/as-manager`,
    parsed.data,
  );
  if ("error" in asManager) return asManager;
  revalidatePath(PAGE);
  return {};
}

export async function setAuthorityAction(id: unknown, input: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const parsed = AuthorityInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call("PUT", `/v1/org-chart/positions/${id}/authority`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

export async function setSkillsAction(id: unknown, input: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const parsed = SkillsInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call("PUT", `/v1/org-chart/positions/${id}/skills`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

export async function addDottedLineAction(id: unknown, input: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  const parsed = DottedLineInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Choose a position." };
  const result = await call("POST", `/v1/org-chart/positions/${id}/dotted-lines`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

export async function endDottedLineAction(id: unknown, managerId: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which position?" };
  if (typeof managerId !== "string" || !managerId) return { error: "Which line?" };
  const result = await call(
    "DELETE",
    `/v1/org-chart/positions/${id}/dotted-lines/${managerId}`,
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

const DepartmentBody = z.object({
  name: z.string().trim().min(1, "Name the department.").max(120),
  colorTag: z.string().trim().max(32).nullish(),
  parentDepartmentId: z.string().uuid().nullish(),
});

export async function createDepartmentAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = DepartmentBody.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call<{ id: string }>("POST", "/v1/org-chart/departments", parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { data: result.data };
}

export async function deleteDepartmentAction(id: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which department?" };
  const result = await call("DELETE", `/v1/org-chart/departments/${id}`);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

const TeamBody = z.object({
  name: z.string().trim().min(1, "Name the team.").max(120),
  departmentId: z.string().uuid().nullish(),
  leadPositionId: z.string().uuid().nullish(),
});

export async function createTeamAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = TeamBody.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call<{ id: string }>("POST", "/v1/org-chart/teams", parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { data: result.data };
}

export async function deleteTeamAction(id: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which team?" };
  const result = await call("DELETE", `/v1/org-chart/teams/${id}`);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

export async function saveChartSettingsAction(input: unknown): Promise<ActionResult> {
  const parsed = OrgChartSettingsInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call("PUT", "/v1/org-chart/settings", parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

// ───────────────────────────────────────────────────────────────────────────
// §6.3 — writing a contract, and its documents
// ───────────────────────────────────────────────────────────────────────────

/**
 * One contract in full, with its document list.
 *
 * Separate from `fetchContractAction`, which the drawer's read-only summary
 * uses: this one hits `GET /contracts/:id`, which the API also treats as a
 * disclosure and writes a `document_access_log` row for. The summary route
 * does not, because listing somebody's employment type on a directory row is
 * not the same act as opening their file.
 */
export async function fetchContractDetailAction(
  id: unknown,
): Promise<ActionResult<{ contract: ContractView; documents: ContractDocumentView[] }>> {
  if (typeof id !== "string" || !id) return { error: "Which contract?" };
  const result = await call<{
    contract: ContractView;
    documents: ContractDocumentView[];
  }>("GET", `/v1/org-chart/contracts/${id}`);
  if ("error" in result) return result;
  return { data: result.data };
}

export async function createContractAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = ContractInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call<{ id: string }>("POST", "/v1/org-chart/contracts", parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { data: result.data };
}

export async function updateContractAction(id: unknown, patch: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which contract?" };
  const parsed = UpdateContractInput.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call("PATCH", `/v1/org-chart/contracts/${id}`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

/**
 * Step one of a document upload: record the version, get a presigned PUT.
 *
 * ── THE ROW EXISTS BEFORE THE BYTES DO, AND THAT IS VISIBLE ────────────────
 *
 * The API writes the `contract_documents` row and returns a 15-minute
 * presigned URL; the browser then PUTs straight to object storage, so a 20 MB
 * signed PDF never passes through the API's memory. The consequence is that a
 * failed or abandoned PUT leaves a row pointing at an object that was never
 * written, and a later download of that version 404s.
 *
 * The console says so rather than hiding it - see `uploadDocument` in the
 * drawer, which reports "the upload did not finish" and tells the person a
 * retry adds a new version. The alternative designs are worse: a
 * confirm-on-upload round trip is a third request that can also fail, and
 * putting the bytes through the API gives up the whole reason for presigning.
 * Recorded in ORG_CHART_DECISIONS.md §6.
 */
export async function startDocumentUploadAction(
  contractId: unknown,
  input: unknown,
): Promise<ActionResult<{ id: string; uploadUrl: string; expiresInSeconds: number }>> {
  if (typeof contractId !== "string" || !contractId) return { error: "Which contract?" };
  const parsed = ContractDocumentInput.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "That file cannot be uploaded." };
  }
  const result = await call<{ id: string; uploadUrl: string; expiresInSeconds: number }>(
    "POST",
    `/v1/org-chart/contracts/${contractId}/documents`,
    parsed.data,
  );
  if ("error" in result) return result;
  return { data: result.data };
}

/**
 * A short-lived URL for one document, which the API logs as an access.
 *
 * 300 seconds, decided by the API - long enough for a slow download, short
 * enough that a URL left in a chat message or a browser history is dead before
 * it is useful. A signed URL IS a credential: anybody holding it reads the
 * document with no further check.
 */
export async function documentUrlAction(
  documentId: unknown,
): Promise<ActionResult<{ url: string; fileName: string }>> {
  if (typeof documentId !== "string" || !documentId) return { error: "Which document?" };
  const result = await call<{ url: string; fileName: string; expiresInSeconds: number }>(
    "GET",
    `/v1/org-chart/contracts/documents/${documentId}/url`,
  );
  if ("error" in result) return result;
  return { data: result.data };
}

/** §7's access trail, for whoever may read the contracts. */
export async function contractAccessLogAction(
  id: unknown,
): Promise<ActionResult<{ entries: ContractAccessEntry[] }>> {
  if (typeof id !== "string" || !id) return { error: "Which contract?" };
  const result = await call<{ entries: ContractAccessEntry[] }>(
    "GET",
    `/v1/org-chart/contracts/${id}/access-log`,
  );
  if ("error" in result) return result;
  return { data: result.data };
}

// ───────────────────────────────────────────────────────────────────────────
// Departments and teams, the rest of the CRUD
// ───────────────────────────────────────────────────────────────────────────

export async function updateDepartmentAction(id: unknown, patch: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which department?" };
  const parsed = DepartmentBody.partial().safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  if (Object.keys(parsed.data).length === 0) return { error: "Nothing to change." };
  const result = await call("PATCH", `/v1/org-chart/departments/${id}`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}

export async function updateTeamAction(id: unknown, patch: unknown): Promise<ActionResult> {
  if (typeof id !== "string" || !id) return { error: "Which team?" };
  const parsed = TeamBody.partial().safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  if (Object.keys(parsed.data).length === 0) return { error: "Nothing to change." };
  const result = await call("PATCH", `/v1/org-chart/teams/${id}`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return {};
}
