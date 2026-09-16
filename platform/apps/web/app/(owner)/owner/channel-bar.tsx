import { ChannelSwitcher } from "@/components/channel-switcher";
import { crmShadowReadEnabled } from "@/lib/crm-cutover";
import { messagingChannelsFor } from "@/lib/nav";
import { getOwner } from "@/lib/owner-context";

/**
 * Renders the messaging switcher for whoever is reading.
 *
 * ── WHY A COMPONENT PER PAGE AND NOT A LAYOUT ───────────────────────────────
 *
 * The Next-idiomatic answer is a shared `layout.tsx` over a `(messaging)`
 * route group, and it was rejected: the five pages live under five paths that
 * are already linked from the rail, from the dashboard and from customers'
 * bookmarks, and a route group means physically moving five directories to
 * gain a layout that renders exactly one element. This is one import and one
 * line per page, no URLs change, and a sixth channel is added by editing
 * nav.ts and dropping the same line into the new page.
 *
 * ── WHY IT RESOLVES ITS OWN ENTITLEMENTS ────────────────────────────────────
 *
 * `getOwner()` is React-cached for the request, so five pages calling it costs
 * one API round trip in total - the layout above has already made it. Reading
 * the persona and modules here rather than threading them down as props keeps
 * the per-page cost to the single line promised above, and means a page cannot
 * render a strip built from the wrong reader's entitlements by forgetting to
 * pass something.
 */
export async function ChannelBar() {
  const owner = await getOwner();
  // The layout redirects a non-owner before any page renders, so this is
  // unreachable in practice. Rendering nothing rather than throwing keeps a
  // future non-owner surface that reuses one of these pages from crashing on
  // its navigation.
  if (!owner) return null;

  const channels = messagingChannelsFor(
    owner.membership.ownerRole,
    crmShadowReadEnabled(),
    owner.membership.enabledModules.includes("crm"),
    owner.membership.enabledModules.includes("call_intel"),
    // Feature toggles too: a client whose operator switched Uploads off should
    // not be offered it here either. The switcher was already derived from the
    // rail precisely so it could never drift from it - this keeps that true
    // now that the rail has a second axis.
    {
      modules: owner.membership.enabledModules,
      features: owner.membership.enabledFeatures,
    },
  );

  return <ChannelSwitcher channels={channels} />;
}
