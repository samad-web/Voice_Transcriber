import "server-only";
import { formatValue, relativeTime } from "@/app/(owner)/owner/types";
import type { ApiResult } from "@/lib/api-result";
import type { GlobalSearchResponse, SearchGroup, SearchHit, SearchHitKind } from "@/lib/global-search";
import { crmShadowReadEnabled } from "@/lib/crm-cutover";
import { ownerNavItemsFor } from "@/lib/nav";
import type { OwnerMembership, Principal } from "@/lib/owner-context";
import { apiTry } from "@/lib/server-api";

/**
 * Where global search gets its answers, per tenant.
 *
 * A seam, not a framework: one interface and the one implementation Aura needs
 * today. A tenant whose records live in an external CRM gets another
 * `CrmSearchSource` that returns the same `GlobalSearchResponse`, chosen in
 * `searchSourceFor` - the route handler and the header component do not change.
 */
export interface CrmSearchSource {
  search(query: string, owner: Principal & { membership: OwnerMembership }): Promise<GlobalSearchResponse>;
}

const PER_KIND = 5;

interface ContactRow {
  id: string;
  display_name: string;
  email: string | null;
  title: string | null;
}
interface DealRow {
  id: string;
  name: string;
  stage: string;
  amount: string | number | null;
  contact_name: string | null;
  account_name: string | null;
}
interface NoteRow {
  id: string;
  type: string;
  subject: string | null;
  snippet: string;
  occurred_at: string;
  contact_id: string;
  contact_name: string;
}

const TYPE_LABEL: Record<string, string> = {
  call: "Call",
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  meeting: "Meeting",
  note: "Note",
};

/**
 * The console pages each kind links to. A kind is searched only when the reader
 * can open its page - the SAME persona/module/feature filter the rail uses - so
 * a result can never be a link that 404s or leads to a page hidden from them.
 * Notes open the contact they belong to.
 */
const PAGE_FOR: Record<SearchHitKind, string> = {
  contact: "/owner/contacts",
  deal: "/owner/deals",
  note: "/owner/contacts",
};

/**
 * One upstream answer → one group, or a note that the kind could not be
 * searched. Exported for its test: which failures become "unavailable" and
 * which stay silent is the part worth pinning.
 */
export function toGroup<T>(
  kind: SearchHitKind,
  label: string,
  result: ApiResult<T> | null,
  pick: (data: T) => SearchHit[],
): { group: SearchGroup | null; unavailable: boolean } {
  // Not searched at all: the reader cannot open this kind's page.
  if (result === null) return { group: null, unavailable: false };
  if (!result.ok) {
    // Forbidden / not found means the grant or module says no. Saying so would
    // tell a scoped rep that deals exist - so it is silence, like no match.
    const denied = result.kind === "forbidden" || result.kind === "notfound";
    return { group: null, unavailable: !denied };
  }
  const hits = pick(result.data).slice(0, PER_KIND);
  return { group: hits.length > 0 ? { kind, label, hits } : null, unavailable: false };
}

export const auraSearchSource: CrmSearchSource = {
  async search(query, owner) {
    const { membership } = owner;
    const visible = new Set(
      ownerNavItemsFor(
        membership.ownerRole,
        crmShadowReadEnabled(),
        membership.enabledModules.includes("crm"),
        membership.enabledModules.includes("call_intel"),
        { modules: membership.enabledModules, features: membership.enabledFeatures },
      ).map((item) => item.href),
    );
    const caller = { ownerRole: membership.ownerRole, userId: owner.userId };
    const q = encodeURIComponent(query);
    const ask = <T>(kind: SearchHitKind, path: string) =>
      visible.has(PAGE_FOR[kind]) ? apiTry<T>(path, membership.orgId, caller) : Promise.resolve(null);

    // In parallel, each through its own scoped endpoint: the list routes carry
    // the permission grid AND the `owned` row filter, so a rep restricted to
    // their own records finds only those (same reasoning as crm-actions.ts's
    // searchRecordsAction).
    const [contacts, deals, notes] = await Promise.all([
      ask<{ contacts: ContactRow[] }>("contact", `/v1/contacts?q=${q}&limit=${PER_KIND}&sort=activity`),
      ask<{ deals: DealRow[] }>("deal", `/v1/deals?q=${q}&limit=${PER_KIND}&sort=activity`),
      ask<{ notes: NoteRow[] }>("note", `/v1/interactions/search?q=${q}&limit=${PER_KIND}`),
    ]);

    const parts = [
      toGroup("contact", "Contacts", contacts, (d) =>
        d.contacts.map((c) => ({
          kind: "contact" as const,
          id: c.id,
          title: c.display_name,
          subtitle: c.email ?? c.title ?? null,
          meta: null,
          href: `/owner/contacts/${c.id}`,
        })),
      ),
      toGroup("deal", "Deals", deals, (d) =>
        d.deals.map((deal) => ({
          kind: "deal" as const,
          id: deal.id,
          title: deal.name,
          subtitle: [deal.stage, deal.account_name ?? deal.contact_name].filter(Boolean).join(" · ") || null,
          meta: deal.amount === null ? null : formatValue(deal.amount),
          href: `/owner/deals?focus=${deal.id}`,
        })),
      ),
      toGroup("note", "Activity notes", notes, (d) =>
        d.notes.map((n) => {
          const type = TYPE_LABEL[n.type] ?? n.type;
          return {
            kind: "note" as const,
            id: n.id,
            title: n.subject || `${type} · ${n.contact_name}`,
            subtitle: n.subject ? `${n.contact_name} · ${n.snippet}` : n.snippet,
            meta: relativeTime(n.occurred_at),
            href: `/owner/contacts/${n.contact_id}`,
          };
        }),
      ),
    ];

    return {
      query,
      groups: parts.flatMap((p) => (p.group ? [p.group] : [])),
      unavailable: (["contact", "deal", "note"] as const).filter((_, i) => parts[i].unavailable),
    };
  },
};

/** The search backend for this tenant. Aura's own tables for every tenant today. */
export function searchSourceFor(_membership: OwnerMembership): CrmSearchSource {
  return auraSearchSource;
}
