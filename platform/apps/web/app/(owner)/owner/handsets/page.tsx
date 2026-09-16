import { redirect } from "next/navigation";

/**
 * Retired destination, kept as a redirect.
 *
 * This route used to render a read-only fleet view while `/owner/devices`
 * rendered the pairing surface migration 0107 gave the client. Both were in
 * the rail, both were labelled "Handsets", and both were in the Settings
 * section - one entry too many, and the reason this file is now three lines.
 *
 * `/owner/devices` absorbed what was here: the per-handset staleness and
 * needs-attention chips read off `/v1/devices/fleet-health` moved onto that
 * page, so nothing this page showed was lost with it.
 *
 * A redirect rather than a deletion, because a URL that shipped is a URL
 * somebody has: a bookmark, a link in an older notification, a message in a
 * support thread. A 404 for a page that was folded into another one is a
 * support conversation; one extra hop is not.
 *
 * An ORDINARY redirect, not the permanent variant, for the reason
 * `/owner/team` states next door: a browser caches a permanent redirect
 * indefinitely, and that is a promise about a URL nobody will reconsider. The
 * two Handsets pages were two readings of who provisions a phone - the client
 * or the operator - and if that question is ever reopened, this path is where
 * the read-only view would come back. Cheap to keep reversible, expensive to
 * un-cache.
 */
export default function HandsetsRedirect() {
  redirect("/owner/devices");
}
