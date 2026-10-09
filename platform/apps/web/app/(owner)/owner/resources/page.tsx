import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { ResourcesConsole, type ResourceView } from "./resources-console";

export const metadata: Metadata = { title: "Bookable resources" };

/**
 * Bookable resources (Build docs/40 §B3, migration 0165).
 *
 * The things a business books: a chair, a room, a scanner, a crew, a bay, a
 * batch of forty seats, a flat in a tower, a 14 Oct departure. 0165 built the
 * table, the RLS, the hold/release protocol and the API; the only screen that
 * ever read any of it was the PARTNER's read-only list, so a tenant could not
 * see their own stock (doc 40, F6).
 *
 * ── OWNER AND MANAGER, AND THE GAP THAT LEAVES ─────────────────────────────
 *
 * `resource:create` goes to the three admin roles only - defining what the
 * business sells is configuration, and a telecaller inventing a second code for
 * a batch that already exists is something the unique index cannot catch.
 *
 * But `resource:edit` deliberately reaches `workspace_member` too, because
 * HOLDING a unit is an edit and holding is a telecaller's whole job here. This
 * page does not serve that: a rep holds a flat while they are talking to the
 * person who wants it, which belongs on the lead, not on a stock list filtered
 * by type. So the grant is wider than this screen, on purpose, and the lead-side
 * hold is still to build. Recorded in doc 40 §B3 rather than papered over by
 * widening the page to a persona it would not help.
 */
export default async function ResourcesPage() {
  await requireFeature("/owner/resources");
  await requireOwnerRoles(["owner", "manager"]);

  const [list, types] = await Promise.all([
    ownerTry<{ resources: ResourceView[]; total: number }>("/v1/resources?limit=200"),
    // The picker's options: what this tenant already uses, plus what their
    // stage pack suggests. No `?pack=` yet - nothing persists which vertical a
    // tenant is, which is exactly what Phase C fixes. Until then the route
    // falls back to the general pack's suggestions and the in-use types, which
    // is the honest answer to a question nobody has recorded.
    ownerTry<{ types: string[]; inUse: Array<{ type: string; count: number }> }>(
      "/v1/resources/types",
    ),
  ]);

  if (!list.ok) {
    return (
      <>
        <PageHeader title="Bookable resources" context="Sales" />
        <LoadFailure what="your bookable resources" failure={list} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Bookable resources" context="Sales" />
      <ResourcesConsole
        initial={list.data.resources}
        total={list.data.total}
        // A failed picker read is not worth failing the page for: the form can
        // still take a typed key, which is the whole point of a suggestion list
        // over a CHECK.
        types={types.ok ? types.data.types : []}
        inUse={types.ok ? types.data.inUse : []}
      />
    </>
  );
}
