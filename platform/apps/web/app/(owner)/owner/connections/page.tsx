import { redirect } from "next/navigation";

/**
 * Connections moved into the Integrations store (doc 28, Q8): a person's own
 * Gmail, Outlook and mailbox are the store's "Mine" view, each with its own
 * app page and connect flow, and the organisation's sign-in apps (0120) are on
 * the Google and Microsoft app pages.
 *
 * This URL stays as a redirect for bookmarks and old links. The sign-in
 * CALLBACK under it (`./callback/route.ts`) does not move at all - it is the
 * redirect URI registered in every organisation's own Google and Microsoft
 * app.
 */
export default function ConnectionsPage() {
  redirect("/owner/integrations?view=mine");
}
