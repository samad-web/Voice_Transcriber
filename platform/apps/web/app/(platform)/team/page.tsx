import { redirect } from "next/navigation";

/**
 * Team moved into Client Configuration, where it is one of three tabs beside
 * Roles and API keys - because a client's team is a client-level asset, not a
 * platform one. See ../client-config/page.tsx for the reasoning.
 *
 * Kept as a redirect rather than deleted, for the same reason
 * `(owner)/owner/team/page.tsx` was: "the Team page" is what people have
 * bookmarked and what they will type, and a 404 for a page that moved is a
 * support conversation where one extra hop is not.
 *
 * `?org=` is carried through, so a link to one client's team still lands on that
 * client rather than silently on the dev org.
 *
 * Permanent in intent but written as an ordinary redirect: Next's permanent
 * variant is cached by the browser indefinitely, which is a promise worth making
 * about a URL that has been retired, not about one that has been moved into a
 * tab it could plausibly move back out of.
 */
export default async function TeamRedirect({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  redirect(`/client-config?tab=team${org ? `&org=${encodeURIComponent(org)}` : ""}`);
}
