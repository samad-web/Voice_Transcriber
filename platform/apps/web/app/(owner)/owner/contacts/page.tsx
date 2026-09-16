import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { Pager } from "@/components/pager";
import { viewHref, viewQueryFrom } from "@/lib/list-views";
import { ownerGet } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { loadMembers, loadTags } from "../list-data";
import { FilterSearch, FilterSelect, ListFilterForm } from "../list-filters";
import { CHANNEL_OPTIONS, ownerOptions, tagOptions, withCurrent, type FilterOption } from "../list-options";
import { SavedViewsBar } from "../saved-views/saved-views-bar";
import { loadSavedViews } from "../saved-views/load";
import type { Contact } from "../types";
import { ContactsTable } from "./contacts-table";

export const metadata: Metadata = { title: "Contacts" };

const PAGE_SIZE = 50;

interface ListResponse {
  contacts: Contact[];
  total: number;
  limit: number;
  offset: number;
}

const SORT_OPTIONS: readonly FilterOption[] = [
  { value: "", label: "Recent activity" },
  { value: "created", label: "Newest" },
  { value: "name", label: "Name A-Z" },
  { value: "score", label: "Lead score" },
];

/**
 * CRM Phase 1 foundation (E0.1) - the Contact list, alongside /owner/leads
 * rather than replacing it. Server-rendered filtering (the query string is the
 * state), same reasoning as leads/page.tsx: a filtered list stays a shareable
 * URL, and a saved view is a name for one (lib/list-views.ts).
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("contacts");

  const sp = await searchParams;
  const current = viewQueryFrom("contacts", sp);
  const offsetRaw = Array.isArray(sp.offset) ? sp.offset[0] : sp.offset;
  const offset = Math.max(0, Number(offsetRaw) || 0);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...current });
  if (offset > 0) query.set("offset", String(offset));

  // Concurrent, and only the list itself can fail the page: the option lists
  // and saved views degrade to empty (list-options.ts, saved-views/load.ts).
  const [data, members, tags, views] = await Promise.all([
    ownerGet<ListResponse>(`/v1/contacts?${query}`),
    loadMembers(),
    loadTags(),
    loadSavedViews("contacts"),
  ]);

  if (!data) {
    return (
      <>
        <PageHeader title="Contacts" context="Pipeline" />
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
      <PageHeader title="Contacts" context="Pipeline" />

      <SavedViewsBar list="contacts" views={views} current={current} allLabel="All contacts" />

      <ListFilterForm key={viewHref("contacts", current)} path="/owner/contacts" label="Filter contacts">
        <FilterSearch defaultValue={current.q} placeholder="Name or email" label="Search contacts" />
        <FilterSelect
          name="owner"
          label="Owner"
          defaultValue={current.owner}
          options={withCurrent(ownerOptions(members), current.owner)}
        />
        {tags.length > 0 || current.tagId ? (
          <FilterSelect
            name="tagId"
            label="Tag"
            defaultValue={current.tagId}
            options={withCurrent(tagOptions(tags), current.tagId)}
          />
        ) : null}
        <FilterSelect name="sourceChannel" label="Came in through" defaultValue={current.sourceChannel} options={CHANNEL_OPTIONS} />
        <FilterSelect name="sort" label="Sort" defaultValue={current.sort} options={SORT_OPTIONS} />
      </ListFilterForm>

      <ContactsTable contacts={data.contacts} filtered={Object.keys(current).some((k) => k !== "sort")} />

      <Pager
        total={data.total}
        page={Math.floor(offset / PAGE_SIZE) + 1}
        pageSize={PAGE_SIZE}
        noun="contact"
        previousLabel="← Previous"
        nextLabel="Next →"
        hrefFor={(page) => {
          const next = new URLSearchParams(current);
          if (page > 1) next.set("offset", String((page - 1) * PAGE_SIZE));
          const qs = next.toString();
          return `/owner/contacts${qs ? `?${qs}` : ""}`;
        }}
      />
    </>
  );
}
