import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { Pager } from "@/components/pager";
import { ownerGet, requireFeature } from "@/lib/owner-context";
import { ProductsClient } from "./products-client";
import type { Product } from "./actions";

export const metadata: Metadata = { title: "Products" };

const PAGE_SIZE = 50;

interface ListResponse {
  products: Product[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * What quotations and invoices pick their line items from.
 *
 * Search-only, no status tabs: the API takes a `status` filter too, but the
 * list is short enough for most tenants that a search box covers it, and
 * archiving happens from the edit dialog rather than by filtering it away.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; offset?: string }>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/products");
  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset) || 0);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (sp.q) query.set("q", sp.q);
  if (offset > 0) query.set("offset", String(offset));

  const data = await ownerGet<ListResponse>(`/v1/products?${query}`);

  if (!data) {
    return (
      <>
        <PageHeader title="Products" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Products" context="Pipeline" />

      <form className="max-w-sm">
        <MonoLabel>Search</MonoLabel>
        <input
          type="search"
          name="q"
          aria-label="Search products"
          defaultValue={sp.q ?? ""}
          placeholder="Name or SKU"
          className="mt-1.5 h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-text placeholder:text-text-muted"
        />
      </form>

      <ProductsClient products={data.products} />

      {data.products.length > 0 ? (
        <Pager
          total={data.total}
          page={Math.floor(offset / PAGE_SIZE) + 1}
          pageSize={PAGE_SIZE}
          hrefFor={(page) => {
            const next = new URLSearchParams(query);
            next.set("offset", String((page - 1) * PAGE_SIZE));
            return `/owner/products?${next}`;
          }}
        />
      ) : null}
    </>
  );
}
