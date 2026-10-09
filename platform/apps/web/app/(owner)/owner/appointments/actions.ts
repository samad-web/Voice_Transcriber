"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AppointmentManualStatus,
  AppointmentTypeKey,
} from "@aura/shared/dist/appointments";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * The diary (Build docs/40 §B2, migration 0166).
 *
 * ── NOTHING HERE SENDS ANYTHING ────────────────────────────────────────────
 *
 * Booking an appointment WRITES REMINDER ROWS - 0166 enqueues them in the same
 * transaction, so there is no window in which an appointment exists with
 * nothing owed. It does not send them. The drain that would turn a row into a
 * message does not exist yet, and when it lands it has to clear all four of
 * `APPOINTMENT_SEND_GATES`: the owner's own switch
 * (`organizations.appointment_reminders_enabled`, default FALSE),
 * WHATSAPP_SENDING_ENABLED, the opt-out check and quiet hours.
 *
 * So this console deliberately offers NO "turn reminders on" toggle, even
 * though that column has no writer anywhere. A switch that arms a sender which
 * does not exist is exactly the kind of control doc 40 was written to find: it
 * would look like a decision and do nothing, and the day the drain shipped it
 * would start messaging customers on the strength of a click somebody made
 * months earlier for a different reason. The diary says what is owed instead.
 *
 * ── THE SCHEMAS ARE COPIES, AND THE API STILL DECIDES ──────────────────────
 *
 * 0166 keeps its bodies in the controller. These mirror the two refinements
 * that matter, because both produce an unreadable database error otherwise:
 * an appointment needs a customer (no customer means no address any reminder
 * could ever reach), and a move has to carry BOTH ends (moving one end either
 * inverts the window - a 23514 nobody can read - or silently changes its
 * length).
 */

const PAGE = "/owner/appointments";

const Timestamp = z.string().datetime({ offset: true }).or(z.string().datetime());

const Create = z
  .object({
    appointmentType: AppointmentTypeKey,
    startsAt: Timestamp,
    endsAt: Timestamp,
    leadId: z.string().uuid().nullable().optional(),
    contactId: z.string().uuid().nullable().optional(),
    resourceId: z.string().uuid().nullable().optional(),
    assignedUserId: z.string().uuid().nullable().optional(),
    location: z.string().trim().max(500).nullable().optional(),
    status: z.enum(["scheduled", "confirmed"]).optional(),
  })
  .refine((b) => new Date(b.endsAt) > new Date(b.startsAt), {
    message: "It has to end after it starts.",
    path: ["endsAt"],
  })
  .refine((b) => Boolean(b.leadId || b.contactId), {
    message: "Say who this is with.",
    path: ["leadId"],
  });

const Update = z
  .object({
    startsAt: Timestamp.optional(),
    endsAt: Timestamp.optional(),
    resourceId: z.string().uuid().nullable().optional(),
    assignedUserId: z.string().uuid().nullable().optional(),
    location: z.string().trim().max(500).nullable().optional(),
    status: AppointmentManualStatus.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to update")
  .refine((b) => (b.startsAt === undefined) === (b.endsAt === undefined), {
    message: "Move both ends or neither.",
    path: ["endsAt"],
  });

const Attendance = z.object({
  attended: z.boolean(),
  outcome: z.string().trim().max(2000).nullable().optional(),
});

type Refusal = { error: string };
type Ok<T> = { data: T };

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
    // Non-JSON: a proxy or a crash rather than a refusal with something to say.
  }
  // 409 is the one worth naming. 0166 refuses a double-booking of the same
  // resource in the same window, and "already booked" is actionable where a
  // status code is not.
  if (res.status === 409) return "That slot is already taken for this resource.";
  return `That didn't save (${res.status}).`;
}

async function call<T>(
  method: "GET" | "POST" | "PATCH",
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

export interface AppointmentResult {
  error?: string;
  appointment?: unknown;
}

export async function createAppointmentAction(input: unknown): Promise<AppointmentResult> {
  const parsed = Create.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call<{ appointment: unknown }>("POST", "/v1/appointments", parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { appointment: result.data.appointment };
}

/**
 * Reschedule, reassign, move the room, confirm or cancel.
 *
 * `rescheduled`, `completed` and `no_show` are NOT settable: 0166 produces the
 * first by moving the times and the other two through the attendance route.
 * Asserting one without doing the thing it describes is how a no-show report
 * stops agreeing with the diary.
 */
export async function updateAppointmentAction(
  id: unknown,
  patch: unknown,
): Promise<AppointmentResult> {
  if (typeof id !== "string" || !id) return { error: "Which appointment?" };
  const parsed = Update.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call<{ appointment: unknown }>(
    "PATCH",
    `/v1/appointments/${id}`,
    parsed.data,
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { appointment: result.data.appointment };
}

/**
 * Did it happen.
 *
 * Its own route because it is its own question: `attended` is separate from
 * `status` in 0166 precisely so "we marked this complete" and "they turned up"
 * cannot be conflated. A no-show is a dead chair nobody can resell, and it is
 * the number the whole vertical pitch rests on - so it has to be recorded by
 * somebody saying so, not inferred from a status.
 */
export async function setAttendanceAction(
  id: unknown,
  attended: unknown,
  outcome?: unknown,
): Promise<AppointmentResult> {
  if (typeof id !== "string" || !id) return { error: "Which appointment?" };
  const parsed = Attendance.safeParse({
    attended,
    ...(typeof outcome === "string" && outcome.trim() ? { outcome: outcome.trim() } : {}),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call<{ appointment: unknown }>(
    "POST",
    `/v1/appointments/${id}/attendance`,
    parsed.data,
  );
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { appointment: result.data.appointment };
}

export interface CustomerHit {
  id: string;
  title: string;
}

/**
 * Leads matching what somebody has typed, for the "who is this with" picker.
 *
 * A server action rather than a route handler because it needs the session's
 * org, and `GET /v1/leads?q=` already does the searching - `(title ILIKE … OR
 * contact_name ILIKE … OR summary ILIKE …)`. Ten results, because this is a
 * picker and not a list: somebody who cannot find their lead in ten has typed
 * too little, and the Leads page is where you browse.
 */
export async function searchLeadsAction(q: unknown): Promise<{ hits: CustomerHit[] }> {
  const text = typeof q === "string" ? q.trim() : "";
  if (text.length < 2) return { hits: [] };
  const result = await call<{ leads: Array<{ id: string; title: string | null }> }>(
    "GET",
    `/v1/leads?q=${encodeURIComponent(text)}&limit=10`,
  );
  if ("error" in result) return { hits: [] };
  return {
    hits: result.data.leads.map((lead) => ({
      id: lead.id,
      title: lead.title?.trim() || "Untitled lead",
    })),
  };
}
