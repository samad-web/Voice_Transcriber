"use server";

import { revalidatePath } from "next/cache";
import {
  OnBehalfRequestInput,
  RequestDecisionInput,
  SegmentOverrideInput,
  isCalendarDate,
} from "@aura/shared";
import { attendanceCall } from "@/lib/attendance-api";
import { issuesByField, type AttendanceRequest, type DayResponse } from "@/lib/attendance";

/**
 * The Attendance page's Server Actions (doc 33 §7.1, §9).
 *
 * Every one pins its own method and path and validates its input with the
 * same zod schema the API uses, so a message the person sees is the API's own
 * sentence either way. The persona check is the API's: a telecaller who
 * forges a call to `decideRequestAction` gets its 403, worded.
 */

export interface AttendanceActionResult {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refresh() {
  revalidatePath("/owner/attendance");
}

/** One person's day for the timeline drawer. A read, but the drawer is client state. */
export async function getDayAction(
  telecallerId: string,
  date: string,
): Promise<{ data?: DayResponse; error?: string }> {
  if (!UUID.test(telecallerId) || !isCalendarDate(date)) return { error: "That day could not be read." };
  const params = new URLSearchParams({ telecallerId, date });
  const result = await attendanceCall<DayResponse>("GET", `/day?${params}`);
  return result.ok ? { data: result.data } : { error: result.error };
}

/** Excuse or unexcuse one classified stretch, with the note the audit log keeps. */
export async function overrideSegmentAction(
  segmentId: string,
  input: { overrideClass: "excused" | "unexcused"; note: string },
): Promise<AttendanceActionResult> {
  if (!UUID.test(segmentId)) return { error: "That stretch could not be found." };
  const parsed = SegmentOverrideInput.safeParse(input);
  if (!parsed.success) return { fieldErrors: issuesByField(parsed.error.issues), error: "Add a note saying why." };
  const result = await attendanceCall<{ ok: boolean }>(
    "POST",
    `/segments/${encodeURIComponent(segmentId)}/override`,
    parsed.data,
  );
  if (!result.ok) return { error: result.error };
  refresh();
  return {};
}

/** Approve or reject a pending request. Rejecting needs a note (the schema says so). */
export async function decideRequestAction(
  requestId: string,
  input: { decision: "approve" | "reject"; note?: string | null },
): Promise<AttendanceActionResult & { request?: AttendanceRequest }> {
  if (!UUID.test(requestId)) return { error: "That request could not be found." };
  const parsed = RequestDecisionInput.safeParse({ ...input, note: input.note?.trim() || null });
  if (!parsed.success) {
    const fieldErrors = issuesByField(parsed.error.issues);
    return { fieldErrors, error: fieldErrors.note ?? "Check the decision and try again." };
  }
  const result = await attendanceCall<{ request: AttendanceRequest }>(
    "POST",
    `/requests/${encodeURIComponent(requestId)}/decision`,
    parsed.data,
  );
  if (!result.ok) return { error: result.error };
  refresh();
  return { request: result.data.request };
}

/** Leave, a break or changed hours recorded for a telecaller - approved in the same step (§6.1). */
export async function recordRequestAction(input: unknown): Promise<AttendanceActionResult & { request?: AttendanceRequest }> {
  const parsed = OnBehalfRequestInput.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = issuesByField(parsed.error.issues);
    return { fieldErrors, error: Object.values(fieldErrors)[0] ?? "Check the form and try again." };
  }
  const result = await attendanceCall<{ request: AttendanceRequest }>("POST", "/requests", parsed.data);
  if (!result.ok) return { error: result.error };
  refresh();
  return { request: result.data.request };
}
