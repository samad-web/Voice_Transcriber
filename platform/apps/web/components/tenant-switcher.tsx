import Link from "next/link";
import { MonoLabel } from "@aura/ui";
import type { TenantOption } from "@/lib/tenant-scope";

export type { TenantOption };

/**
 * The operator console manages every customer, but the org-scoped pages read
 * one tenant at a time (RLS is per-org). Without this control those pages
 * silently render the environment's DEV_ORG_ID and look like platform-wide
 * totals - the switcher makes the tenant the page is about explicit and
 * changeable via `?org=`.
 */
export function TenantSwitcher({
  tenants,
  activeOrgId,
  basePath,
  label = "Viewing tenant",
  extraQuery,
}: {
  tenants: TenantOption[];
  activeOrgId: string;
  /** Path only - the query is built here, so this must carry no `?`. */
  basePath: string;
  label?: string;
  /**
   * Query params to keep across a tenant switch, beside `org`.
   *
   * Needed by a page whose state lives in the URL: /client-config holds its
   * active tab there, and without this, switching client from the API Keys tab
   * would silently drop you back on Team.
   */
  extraQuery?: Record<string, string>;
}) {
  if (tenants.length <= 1) return null;

  const suffix = Object.entries(extraQuery ?? {})
    .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("");

  return (
    <div className="space-y-2">
      <MonoLabel>{label}</MonoLabel>
      <div className="flex flex-wrap gap-2">
        {tenants.map((t) => (
          <Link
            key={t.id}
            href={`${basePath}?org=${t.id}${suffix}`}
            aria-current={t.id === activeOrgId ? "page" : undefined}
            className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
              // "Selected" is a sanctioned accent use (doc 16 §1.1). Everything
              // else in this row stays neutral so the chosen tenant is the only
              // coloured thing on the strip.
              t.id === activeOrgId
                ? "border-transparent bg-accent-subtle text-accent-text"
                : "border-border-strong bg-surface text-text hover:bg-surface-hover hover:border-text-subtle"
            }`}
          >
            {t.name}
          </Link>
        ))}
      </div>
    </div>
  );
}
