"use server";

import type { ContactActivity } from "@/lib/crm-activity";
import { activitySourceFor } from "@/lib/crm-activity";
import { getOwner } from "@/lib/owner-context";

/**
 * A contact's merged activity feed, for the 360° record to refresh itself after
 * logging something. The contact's name is taken from the caller only for the
 * sentences ("Priya sent a WhatsApp message") - the records themselves are read
 * under the session's own tenant and grants, never from anything passed in.
 */
export async function fetchContactActivityAction(
  contactId: string,
  displayName: string,
  /** How many logged activities to compose - the "Show older" step (Phase 8). */
  interactionLimit?: number,
): Promise<ContactActivity & { error?: string }> {
  const owner = await getOwner();
  if (!owner) return { items: [], unavailable: [], truncated: false, error: "Not signed in as an instance owner" };
  if (!/^[0-9a-f-]{36}$/i.test(contactId)) {
    return { items: [], unavailable: [], truncated: false, error: "Unknown contact" };
  }
  return activitySourceFor(owner.membership).forContact(
    { id: contactId, displayName: displayName.slice(0, 200) },
    owner,
    { interactionLimit },
  );
}
