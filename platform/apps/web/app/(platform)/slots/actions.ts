"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { getPrincipal } from "@/lib/owner-context";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";

/**
 * Bookable slots.
 *
 * Every export opens with a bare `await requireOperator()` - a Server Action is
 * an independently-addressable POST endpoint and these carry the root
 * ADMIN_API_KEY. Enforced mechanically by platform-actions.guard.test.ts.
 */

export interface Slot {
  id: string;
  starts_at: string;
  ends_at: string;
  status: "open" | "booked";
  booked_name: string | null;
  booked_at: string | null;
  submission_id: string | null;
  /** Computed in the target zone by Postgres, so the client never re-derives it. */
  local_date: string;
  local_time: string;
  duration_minutes: string;
}

export interface SlotsResult {
  slots?: Slot[];
  timeZone?: string;
  error?: string;
}

export async function listSlotsAction(
  from: string,
  to: string,
  timeZone: string,
): Promise<SlotsResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const q = new URLSearchParams({ from, to, timeZone });
    const res = await fetch(`${API_URL}/v1/admin/slots?${q}`, {
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 404) return { error: "The slots endpoint is not available. Is the API on the current build?" };
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    return { slots: data.slots ?? [], timeZone: data.timeZone };
  } catch {
    return { error: "API unreachable - is `pnpm --filter @aura/api dev` running?" };
  }
}

/* ── Booked calls ───────────────────────────────────────────────────────────
   The diary above answers "when am I free". This answers "who am I speaking to
   and how do I reach them", which is the question somebody actually opens this
   page to ask. The contact details come from the enquirer's submission, joined
   server-side - a name alone is not enough to make a call. */

export interface Booking {
  id: string;
  starts_at: string;
  booked_at: string | null;
  booked_name: string | null;
  submission_id: string | null;
  calendar_event_id: string | null;
  calendar_error: string | null;
  day_label: string;
  time_label: string;
  duration_minutes: string;
  /** Null when the enquirer was erased - the appointment still stands. */
  enquirer_name: string | null;
  enquirer_email: string | null;
  enquirer_phone: string | null;
  business_type: string | null;
  team_size: string | null;
  budget_inr: string | null;
  crm_name: string | null;
  crm_satisfied: string | null;
  lead_status: string | null;
  /** Null until somebody marks it. Migration 0053. */
  attendance: "attended" | "no_show" | null;
  attendance_recorded_at: string | null;
  attendance_recorded_by: string | null;
}

export interface BookingsResult {
  bookings?: Booking[];
  timeZone?: string;
  error?: string;
}

/**
 * The booked calls on a run of calendar days in the scheduler's zone - the
 * page's date control, resolved to dates (booking-range.ts). The API caps a
 * range at 366 days, so "show me what needs marking" cannot turn into "show me
 * every call ever".
 */
export async function listBookingsAction(range: {
  from: string;
  to: string;
  timeZone: string;
}): Promise<BookingsResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const q = new URLSearchParams(range);
    const res = await fetch(`${API_URL}/v1/admin/slots/booked?${q}`, {
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 404) {
        return { error: "The bookings endpoint is not available. Is the API on the current build?" };
      }
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    return { bookings: data.bookings ?? [], timeZone: data.timeZone };
  } catch {
    return { error: "API unreachable - is `pnpm --filter @aura/api dev` running?" };
  }
}

export interface CreateSlotsResult {
  created?: number;
  skipped?: number;
  error?: string;
}

export async function createSlotsAction(input: {
  date: string;
  times: string[];
  durationMinutes: number;
  timeZone: string;
}): Promise<CreateSlotsResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  // `||` not `??`. getPrincipal() can return a principal whose email is an
  // empty string (no session in development), and `?? "console"` only replaces
  // null or undefined - so "" sailed through and the API rejected the request
  // with `actor: too_small`. Found by clicking the button, not by typechecking.
  const actor = (await getPrincipal())?.email || "console";
  try {
    const res = await fetch(`${API_URL}/v1/admin/slots`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ ...input, actor }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    revalidatePath("/slots");
    return { created: data.created?.length ?? 0, skipped: data.skipped ?? 0 };
  } catch {
    return { error: "API unreachable - is `pnpm --filter @aura/api dev` running?" };
  }
}

export interface AttendanceResult {
  attendance?: "attended" | "no_show";
  /** How many messages were queued. 0 means the enquirer had been erased. */
  queued?: number;
  hasEnquirer?: boolean;
  error?: string;
}

/**
 * Record whether a booked call happened, and let the API queue what follows.
 *
 * The messages are NOT queued here. That is deliberate and not just a layering
 * preference: the API writes the outcome and the outbox rows in one
 * transaction, so there is no window in which the console believes it marked a
 * call and nobody was told, or told somebody about an outcome that was never
 * recorded. Two fetches from here could not offer that.
 *
 * Revalidates `/leads` as well as `/slots` - the leads table shows the booking
 * beside each enquirer, so an outcome recorded here changes what that page
 * should say.
 */
export async function markAttendanceAction(
  id: string,
  outcome: "attended" | "no_show",
): Promise<AttendanceResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  // `||` not `??` - see createSlotsAction. An empty email sails past `??` and
  // the API rejects the request with `actor: too_small`.
  const actor = (await getPrincipal())?.email || "console";
  try {
    const res = await fetch(`${API_URL}/v1/admin/slots/${id}/attendance`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ outcome, actor }),
    });
    if (!res.ok) {
      if (res.status === 404) {
        // The API's own guard is `attendance IS NULL`, so this is overwhelmingly
        // "somebody already marked it" rather than a missing row - said in those
        // terms, because "API 404" would send an operator looking for a bug.
        return { error: "That call has already been marked, or is no longer booked." };
      }
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    revalidatePath("/slots");
    revalidatePath("/leads");
    return { attendance: data.attendance, queued: data.queued, hasEnquirer: data.hasEnquirer };
  } catch {
    return { error: "API unreachable - is `pnpm --filter @aura/api dev` running?" };
  }
}

export async function cancelSlotAction(id: string): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/admin/slots/${id}`, {
      method: "DELETE",
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath("/slots");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}


export interface GenerateResult {
  created?: number;
  requested?: number;
  skipped?: number;
  error?: string;
}

/**
 * Bulk-generate slots across a date range.
 *
 * The buffer is applied by spacing the generated times, not by a rule enforced
 * at booking - see the controller. So what comes back from this is exactly what
 * the diary will look like.
 */
export async function generateSlotsAction(input: {
  fromDate: string;
  toDate: string;
  weekdays: number[];
  dayStart: string;
  dayEnd: string;
  durationMinutes: number;
  bufferMinutes: number;
  timeZone: string;
}): Promise<GenerateResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const actor = (await getPrincipal())?.email || "console";
  try {
    const res = await fetch(`${API_URL}/v1/admin/slots/generate`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ ...input, actor }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // The API's guard rails (92 days, 600 slots, dayEnd after dayStart) come
      // back as 400s with a readable message; surface it rather than a status.
      const msg = Array.isArray(body.message)
        ? body.message.map((i: { message?: string }) => i.message).filter(Boolean).join("; ")
        : body.message;
      return { error: msg || `API ${res.status}` };
    }
    const data = await res.json();
    revalidatePath("/slots");
    return { created: data.created, requested: data.requested, skipped: data.skipped };
  } catch {
    return { error: "API unreachable - is `pnpm --filter @aura/api dev` running?" };
  }
}
