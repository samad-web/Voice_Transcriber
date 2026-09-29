import { redirect } from "next/navigation";

/**
 * Team moved into the client's own instance, where it is one of three tabs on
 * the Access page beside Roles and API keys. Every row it shows carries an `org_id`, so
 * it was always a question about one client rather than about the platform -
 * which is what doc 34 Part B moved the whole screen under `/instances/<id>` to
 * say. See ../instances/[id]/access/page.tsx.
 *
 * TWO hops of history now lead here: this URL first became
 * `/client-config?tab=team`, and that page has since moved again. Both are kept
 * rather than deleted, for the reason the first one gave: "the Team page" is
 * what people have bookmarked and what they will type, and a 404 for a page that
 * moved is a support conversation where one extra hop is not.
 *
 * Without `?org=` there is no instance to redirect INTO, and guessing one is how
 * an operator ends up looking at the wrong customer. The client list is the
 * honest answer instead - it is the one page that can ask the question.
 *
 * Permanent in intent but written as an ordinary redirect: Next's permanent
 * variant is cached by the browser indefinitely, which is a promise worth making
 * about a URL that has been retired, not about one that has been moved.
 */
export default async function TeamRedirect({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  if (!org) redirect("/instances");
  redirect(`/instances/${encodeURIComponent(org)}/access?tab=team`);
}
