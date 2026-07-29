import Link from "next/link";
import { MonoLabel } from "@aura/ui";
import type { TenantOption } from "@/lib/tenant-scope";

export type { TenantOption };

/**
 * The operator console manages every customer, but the org-scoped pages read
 * one tenant at a time (RLS is per-org). Without this control those pages
 * silently render the environment's DEV_ORG_ID and look like platform-wide
 * totals — the switcher makes the tenant the page is about explicit and
 * changeable via `?org=`.
 */
export function TenantSwitcher({
  tenants,
  activeOrgId,
  basePath,
  label = "Viewing tenant",
}: {
  tenants: TenantOption[];
  activeOrgId: string;
  basePath: string;
  label?: string;
}) {
  if (tenants.length <= 1) return null;

  return (
    <div className="space-y-2">
      <MonoLabel>{label}</MonoLabel>
      <div className="flex flex-wrap gap-2">
        {tenants.map((t) => (
          <Link
            key={t.id}
            href={`${basePath}?org=${t.id}`}
            aria-current={t.id === activeOrgId ? "page" : undefined}
            className={`px-3 py-1.5 border-2 border-black text-[10px] font-mono font-bold uppercase tracking-wider ${
              t.id === activeOrgId
                ? "bg-black text-white"
                : "bg-white text-black hover:bg-neutral-100"
            }`}
          >
            {t.name}
          </Link>
        ))}
      </div>
    </div>
  );
}
