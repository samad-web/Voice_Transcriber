import { PageHeader } from "@/components/page-header";
import { operatorGate } from "@/lib/operator-gate";
import { loadOrg } from "../instance-data";
import { SearchExplorer } from "./search-explorer";

/**
 * Transcript search for ONE customer - the tenant named by `[id]`, which is the
 * org id and therefore the RLS boundary. The searching itself goes through a
 * guarded Server Action; this page renders the explorer and the tenant's name.
 *
 * Still opens with `operatorGate()`, and still must. `loadOrg` fetches on the
 * RENDER path, which is the race `platform-pages.guard.test.ts`'s header
 * describes: Next renders a layout and its page in one pass, so
 * `(platform)/layout.tsx`'s `isOperator()` is not guaranteed to have resolved
 * before this page's own fetch goes out.
 *
 * Doc 34 Part B moved this out of the top-level rail. It used to resolve its
 * tenant from `?org=` via `resolveTenantScope`, which read `/v1/admin/tenants` -
 * every customer on the platform, on the root admin key - only to draw a
 * switcher. One `/v1/org` read replaces that, and the URL now says whose
 * transcripts these are.
 */
export default async function SearchPage({ params }: { params: Promise<{ id: string }> }) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const org = await loadOrg(orgId);

  return (
    <>
      <PageHeader title="Transcript Search" />
      <SearchExplorer orgId={orgId} tenantName={org.name} />
    </>
  );
}
