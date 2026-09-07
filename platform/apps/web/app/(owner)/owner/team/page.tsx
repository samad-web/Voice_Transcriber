import { redirect } from "next/navigation";

/**
 * The Team page moved into the Staff section (three tabs: Team, Roles &
 * permissions, Performance).
 *
 * Kept as a redirect rather than deleted. The dashboard's own panel linked
 * here, every owner who ever managed their people has it bookmarked, and the
 * memory of "the Team page" is what people will type. A 404 for a page that
 * was renamed is a support conversation; one extra hop is not.
 *
 * Permanent in intent but written as an ordinary redirect: Next's permanent
 * variant is cached by the browser indefinitely, which is a promise worth
 * making about a URL that has been retired, not about one that has been moved
 * into a tab it could plausibly move back out of.
 */
export default function TeamRedirect() {
  redirect("/owner/staff?tab=team");
}
