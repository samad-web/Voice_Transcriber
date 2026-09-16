import { notFound } from "next/navigation";
import { ORG_FEATURES, featureEnabled, type OrgFeature } from "@aura/shared";
import { getOwner } from "@/lib/owner-context";

/**
 * The page half of the feature system (migration 0093).
 *
 * ── WHY PAGES AND NOT ONLY THE RAIL ─────────────────────────────────────────
 *
 * Hiding a nav item hides the door, not the room. A client who has bookmarked
 * `/owner/invoices`, or who follows a link in an old email, reaches a page that
 * renders perfectly well - and an operator who switched Invoices off has been
 * told, by the console, that they turned it off. A toggle that only sometimes
 * takes effect is worse than no toggle, because it is trusted.
 *
 * ── WHY NOT MIDDLEWARE ──────────────────────────────────────────────────────
 *
 * Middleware is the one place that knows the pathname before anything renders,
 * which makes it the obvious home for this - and it would cost an API round
 * trip on every navigation to resolve the org's entitlement. This platform runs
 * its API in Mumbai against a database in Seoul; that is ~125ms added to every
 * page in the product to enforce a visibility preference. `getOwner()` is
 * React-cached per request and the layout has already called it, so doing it
 * here is free.
 *
 * ── WHY notFound() AND NOT A MESSAGE ────────────────────────────────────────
 *
 * A feature the client is not provisioned for should not advertise itself. "You
 * do not have Invoices" tells somebody there is an Invoices product to ask for,
 * which is a sales conversation the operator who switched it off may not want
 * to have on the client's terms. `notFound()` renders the console's own 404 and
 * says nothing.
 *
 * That reasoning does NOT extend to a real permission denial, which must always
 * explain itself - a person who cannot open a page their colleague can needs to
 * know why. This is not that: it is a page the whole tenant does not have.
 */
export async function requireOwnerFeature(feature: OrgFeature): Promise<void> {
  const owner = await getOwner();
  // No membership at all: the owner layout has already redirected, so this is
  // unreachable in a normal render. Not a reason to grant the feature.
  if (!owner) notFound();

  const { enabledModules, enabledFeatures } = owner.membership;
  if (!featureEnabled(feature, enabledModules, enabledFeatures)) notFound();
}

/**
 * Every feature id, for the source-scan test that keeps this honest.
 *
 * The catalogue names the routes each feature governs, and
 * `owner-features.guard.test.ts` asserts that every one of those routes calls
 * `requireOwnerFeature` with the matching id. Without that, this helper is
 * opt-in - and the page somebody forgets is exactly the page a bookmark
 * reaches.
 */
export const GATED_ROUTES: Array<{ feature: OrgFeature; hrefs: string[] }> = ORG_FEATURES.map(
  (f) => ({ feature: f.id, hrefs: f.hrefs }),
);
