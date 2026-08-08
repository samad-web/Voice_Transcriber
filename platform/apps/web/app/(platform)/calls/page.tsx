import Link from "next/link";
import { Phone } from "lucide-react";
import { Card, EmptyState, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { Pager, PAGE_SIZE } from "@/components/pager";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { CallsExplorer, type CallRow } from "./calls-explorer";

/**
 * Cross-tenant call log. Calls are readable only under one org context at a
 * time (RLS), so the page reads the tenant named in `?org=` and falls back to
 * the environment's dev org — with a switcher, so the operator can tell which
 * customer these calls belong to instead of assuming they are all of them.
 */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; page?: string; followUp?: string }>;
}) {
  const { org, page, followUp } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  const pageNo = Math.max(1, Number(page) || 1);
  const offset = (pageNo - 1) * PAGE_SIZE;
  // Only "true" is honoured. A stray ?followUp=maybe should show the whole log
  // rather than silently filtering to something the operator did not ask for.
  const onlyFollowUps = followUp === "true";

  const data = await apiGetAs<{ calls: CallRow[]; total: number }>(
    `/v1/calls?limit=${PAGE_SIZE}&offset=${offset}${onlyFollowUps ? "&followUp=true" : ""}`,
    orgId,
  );

  /** Keeps the active view when paging, so page 2 of the follow-ups is still follow-ups. */
  const hrefWith = (p: number) =>
    `/calls?org=${orgId}${onlyFollowUps ? "&followUp=true" : ""}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <>
      {/* Title text is deliberately verbatim from NAV_ITEMS: (platform)/loading.tsx
          renders the nav's title for real while the page streams, so any drift
          here shows up as the heading changing under the reader. Sentence-casing
          the console's titles is a change to lib/nav.ts, not to this page. */}
      <PageHeader title="Call Log Explorer" />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/calls" />

      {/* Two views, not a filter panel: "everything" and "people we have spoken
          to before". Paging resets to page 1 when switching, because page 4 of
          one view is meaningless in the other. */}
      <div className="flex gap-2">
        {[
          { label: "All calls", active: !onlyFollowUps, href: `/calls?org=${orgId}` },
          {
            label: "Follow-ups",
            active: onlyFollowUps,
            href: `/calls?org=${orgId}&followUp=true`,
          },
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tab.href}
            // aria-current, not colour alone: the active tab is an accent fill
            // and a colour-blind or greyscale reader gets nothing from that.
            aria-current={tab.active ? "page" : undefined}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out ${
              tab.active
                ? "border-accent bg-accent text-accent-fg"
                : "border-border-strong bg-surface text-text hover:bg-surface-hover"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API — start it with{" "}
            <code className="font-mono">pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : data.calls.length === 0 ? (
        <EmptyState
          icon={<Phone className="h-8 w-8" />}
          title={
            onlyFollowUps
              ? "No repeat callers yet"
              : activeTenant
                ? `No calls ingested for ${activeTenant.name} yet`
                : "No calls ingested yet"
          }
          description={
            onlyFollowUps
              ? "Every call in this log is a first contact. A caller who rings back a second time appears here."
              : "Enroll a device on this tenant and record the first call — it lands here within a minute of the call ending."
          }
        />
      ) : (
        <>
          <Pager
            total={data.total}
            page={pageNo}
            hrefFor={hrefWith}
          />
          <Card className="overflow-hidden p-0">
            <CallsExplorer calls={data.calls} orgId={orgId} showInstance />
          </Card>
        </>
      )}
    </>
  );
}
