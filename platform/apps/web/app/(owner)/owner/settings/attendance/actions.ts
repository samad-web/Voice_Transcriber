"use server";

import { revalidatePath } from "next/cache";
import { AttendanceSettingsInput, ExceptionInput, PeopleUpdateInput, ShiftPatternInput } from "@aura/shared";
import { attendanceCall } from "@/lib/attendance-api";
import {
  issuesByField,
  type AttendanceException,
  type AttendanceSettings,
  type ShiftPattern,
} from "@/lib/attendance";

/**
 * Settings → Team → Attendance (doc 33 §7.1). Owner and manager; the API's
 * `@RequireOwnerRole("owner", "manager")` is the control, and the WhatsApp
 * toggle is narrower still (owners only), which the API also enforces.
 *
 * Each action validates with the shared schema first, so a mistake is caught
 * with the same message the API would have sent, before a round trip.
 */

export interface SettingsActionResult {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refresh() {
  revalidatePath("/owner/settings/attendance");
  revalidatePath("/owner/attendance");
}

function invalid(issues: readonly { path: readonly PropertyKey[]; message: string }[]): SettingsActionResult {
  const fieldErrors = issuesByField(issues);
  return { fieldErrors, error: Object.values(fieldErrors)[0] ?? "Check the form and try again." };
}

/** A partial PUT: only the fields sent change (the schema has no defaults, on purpose). */
export async function updateAttendanceSettingsAction(
  patch: unknown,
): Promise<SettingsActionResult & { settings?: AttendanceSettings }> {
  const parsed = AttendanceSettingsInput.safeParse(patch);
  if (!parsed.success) return invalid(parsed.error.issues);
  if (Object.keys(parsed.data).length === 0) return {};
  const result = await attendanceCall<AttendanceSettings>("PUT", "/settings", parsed.data);
  if (!result.ok) return { error: result.error };
  refresh();
  return { settings: result.data };
}

export async function savePatternAction(
  id: string | null,
  input: unknown,
): Promise<SettingsActionResult & { pattern?: ShiftPattern }> {
  if (id !== null && !UUID.test(id)) return { error: "That shift pattern could not be found." };
  const parsed = ShiftPatternInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const result = id
    ? await attendanceCall<{ pattern: ShiftPattern }>("PATCH", `/patterns/${encodeURIComponent(id)}`, parsed.data)
    : await attendanceCall<{ pattern: ShiftPattern }>("POST", "/patterns", parsed.data);
  if (!result.ok) return { error: result.error };
  refresh();
  return { pattern: result.data.pattern };
}

/** Archives: the API keeps the row so past timesheets still name the pattern they ran on. */
export async function archivePatternAction(id: string): Promise<SettingsActionResult> {
  if (!UUID.test(id)) return { error: "That shift pattern could not be found." };
  const result = await attendanceCall<{ ok: boolean }>("DELETE", `/patterns/${encodeURIComponent(id)}`);
  if (!result.ok) return { error: result.error };
  refresh();
  return {};
}

export async function updatePeopleAction(
  input: unknown,
): Promise<SettingsActionResult & { updated?: number }> {
  const parsed = PeopleUpdateInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const result = await attendanceCall<{ updated: number }>("PUT", "/people", parsed.data);
  if (!result.ok) return { error: result.error };
  refresh();
  return { updated: result.data.updated };
}

export async function createExceptionAction(
  input: unknown,
): Promise<SettingsActionResult & { exception?: AttendanceException }> {
  const parsed = ExceptionInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues);
  const result = await attendanceCall<{ exception: AttendanceException }>("POST", "/exceptions", parsed.data);
  if (!result.ok) return { error: result.error };
  refresh();
  return { exception: result.data.exception };
}

export async function deleteExceptionAction(id: string): Promise<SettingsActionResult> {
  if (!UUID.test(id)) return { error: "That entry could not be found." };
  const result = await attendanceCall<{ ok: boolean }>("DELETE", `/exceptions/${encodeURIComponent(id)}`);
  if (!result.ok) return { error: result.error };
  refresh();
  return {};
}
