"use server";

import { revalidatePath } from "next/cache";
import { portalSend } from "../portal-context";

/**
 * The portal's two writes.
 *
 * Server actions rather than route handlers, for the reason the rest of the
 * console uses them: the admin key lives on this server and must never reach
 * the browser, so the browser posts a form to Next and Next posts to the API.
 *
 * Neither returns a redirect. `submitLeadAction` answers in place because a
 * broker submitting a list of referrals should stay on the form - navigating
 * them to a confirmation page after every one would make twelve submissions
 * twenty-four page loads.
 */

export interface PortalActionResult {
  ok: boolean;
  message: string;
}

export async function submitLeadAction(formData: FormData): Promise<PortalActionResult> {
  const read = (key: string): string | undefined => {
    const raw = formData.get(key);
    const value = typeof raw === "string" ? raw.trim() : "";
    return value === "" ? undefined : value;
  };

  const name = read("name");
  const phone = read("phone");
  const email = read("email");
  if (!name && !phone && !email) {
    // Answered here rather than by the API so the form says it instantly. The
    // API enforces the same rule - it is the one every intake path enforces -
    // and this is the copy, not the boundary.
    return { ok: false, message: "Enter at least a name, a phone number or an email address." };
  }

  const res = await portalSend<{ submissionId: string }>("/v1/portal/submissions", "POST", {
    name,
    phone,
    email,
    note: read("note"),
  });
  if (!res.ok) return { ok: false, message: res.message };

  // The submissions list has a new row. Revalidated rather than left stale,
  // because the confirmation below tells them to go and look at it.
  revalidatePath("/portal/submissions");
  return {
    ok: true,
    message: `Sent. ${name ?? phone ?? email} is with the team - you'll see the outcome under My submissions.`,
  };
}

export async function updatePortalProfileAction(formData: FormData): Promise<PortalActionResult> {
  const raw = formData.get("name");
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "") return { ok: false, message: "Enter your name." };

  const res = await portalSend<{ name: string }>("/v1/portal/profile", "PATCH", { name });
  if (!res.ok) return { ok: false, message: res.message };
  revalidatePath("/portal/profile");
  return { ok: true, message: "Saved." };
}
