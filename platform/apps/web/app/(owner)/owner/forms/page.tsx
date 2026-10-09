import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature, requireOwnerRoles } from "@/lib/owner-context";
import { FormsConsole, type WebFormView } from "./forms-console";

export const metadata: Metadata = { title: "Web forms" };

/**
 * Where a published form is served from.
 *
 * Resolved on the SERVER, because `SITE_DOMAIN` is an ordinary environment
 * variable rather than a `NEXT_PUBLIC_` one - the marketing container is the
 * only service on public traffic and its env is a deliberate allowlist, so
 * nothing here should be bundled into a browser. Null when it is unset, and the
 * console then shows the path alone rather than inventing a hostname: a "copy
 * link" button that copies `https://undefined/f/contact` is worse than no
 * button.
 */
function publicFormBase(): string | null {
  const domain = process.env.SITE_DOMAIN?.trim();
  if (!domain) return null;
  return domain.startsWith("http") ? domain.replace(/\/$/, "") : `https://${domain}`;
}

/**
 * Web forms (Build docs/40 §B4, migration 0161).
 *
 * 0161 built the table, the platform-wide slug rules, the whole field schema in
 * `@aura/shared`, the public render and submit routes and the honeypot. Nothing
 * ever reached the four authenticated routes, so a tenant could not create a
 * form at all (doc 40, F4).
 *
 * ── OWNER AND MANAGER ──────────────────────────────────────────────────────
 *
 * `web_form:create` and `web_form:edit` go to the admin roles; the page follows
 * the write grants rather than the read one. A form is a public URL in the
 * business's name that collects strangers' phone numbers under a consent
 * sentence - 0161's own comment calls publishing one "not floor work", and
 * that is the right reading.
 */
export default async function WebFormsPage() {
  await requireFeature("/owner/forms");
  await requireOwnerRoles(["owner", "manager"]);

  const list = await ownerTry<{ forms: WebFormView[]; can?: { create: boolean; edit: boolean } }>(
    "/v1/web-forms",
  );

  if (!list.ok) {
    return (
      <>
        <PageHeader title="Web forms" context="Settings" />
        <LoadFailure what="your web forms" failure={list} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Web forms" context="Settings" />
      <FormsConsole
        initial={list.data.forms}
        publicBase={publicFormBase()}
        // An older API that predates the `can` block omits it. Default to able:
        // the page is already behind owner/manager, and a silent read-only
        // render reads as a bug rather than as a permission.
        can={list.data.can ?? { create: true, edit: true }}
      />
    </>
  );
}
