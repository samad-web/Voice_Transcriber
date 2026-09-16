import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORG_FEATURES } from "@aura/shared";
import { blankNonCode } from "@/lib/test-support/source-scan";
import { OWNER_NAV_ITEMS, ownerNavItemsFor } from "@/lib/nav";

/**
 * Every feature-governed page actually calls its gate.
 *
 * ── WHY THIS IS A TEST AND NOT A CONVENTION ─────────────────────────────────
 *
 * `requireOwnerFeature` is opt-in: a page that forgets it renders perfectly
 * well for a tenant whose operator switched the feature off. Nothing fails,
 * nothing logs, and the only way anyone finds out is a customer opening a
 * bookmark to a page they were told they do not have.
 *
 * That is the same failure shape `(platform)/platform-actions.guard.test.ts`
 * exists for - a guard that is one forgotten line from being absent - so it
 * gets the same treatment: reflect over the real files, and assert the call is
 * there. The catalogue names the routes, so a feature added without its gate,
 * or a page moved without updating the catalogue, fails here rather than in
 * production.
 *
 * ── AND WHY IT SCANS CODE, NOT TEXT ─────────────────────────────────────────
 *
 * `blankNonCode` first, so a `requireOwnerFeature` mentioned in a comment
 * cannot satisfy the check. A commented-out gate is exactly the state a page
 * ends up in while somebody debugs it locally, and it is the one this must
 * catch rather than wave through.
 */

const OWNER_ROOT = join(__dirname);

/**
 * `/owner/reports/sla` → app/(owner)/owner/reports/sla/page.tsx
 *
 * Only the leading slash comes off. The route group directory is literally
 * `(owner)` and the segment inside it is also `owner`, so stripping the
 * `/owner` prefix - the obvious-looking thing - resolves every page one level
 * too high and silently reports the whole catalogue as missing.
 */
function pageFor(href: string): string {
  return join(OWNER_ROOT, href.replace(/^\//, ""), "page.tsx");
}

describe("feature gating", () => {
  it("has a page file for every route the catalogue governs", () => {
    // The catalogue is hand-written and the routes are directories; a rename
    // on either side silently un-gates a page. Checked first, so the missing
    // file is reported as itself rather than as a missing gate call.
    const missing = ORG_FEATURES.flatMap((f) =>
      f.hrefs.filter((href) => !existsSync(pageFor(href))).map((href) => `${f.id}: ${href}`),
    );
    expect(missing).toEqual([]);
  });

  it("calls requireOwnerFeature with the right id on every governed page", () => {
    const offenders: string[] = [];
    for (const feature of ORG_FEATURES) {
      for (const href of feature.hrefs) {
        const file = pageFor(href);
        if (!existsSync(file)) continue;
        const raw = readFileSync(file, "utf8");
        // TWO checks against two views of the same file, because neither is
        // sufficient alone. `blankNonCode` erases string literals as well as
        // comments - that is its job - so the feature id is blank in the code
        // view and can only be matched in the raw text; and the raw text
        // cannot tell a real call from one inside a comment. So: the CALL must
        // survive blanking, and the ID must appear in the source.
        const isCode = blankNonCode(raw).includes("requireOwnerFeature(");
        const namesFeature = raw.includes(`requireOwnerFeature("${feature.id}")`);
        if (!isCode || !namesFeature) {
          offenders.push(`${href} should call requireOwnerFeature("${feature.id}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gates BEFORE the page fetches anything", () => {
    // Order matters twice over: a page this tenant is not provisioned for
    // should not cost an API round trip, and it must not 404 only after a
    // failed fetch has already proved the data behind it exists.
    const offenders: string[] = [];
    for (const feature of ORG_FEATURES) {
      for (const href of feature.hrefs) {
        const file = pageFor(href);
        if (!existsSync(file)) continue;
        const code = blankNonCode(readFileSync(file, "utf8"));
        // From the body only. `ownerGet` appears in the import list at the top
        // of most of these files, which is not a fetch - comparing raw offsets
        // would report every page as fetching before it gates.
        const bodyAt = code.indexOf("export default");
        if (bodyAt < 0) continue;
        const body = code.slice(bodyAt);
        const gate = body.indexOf("requireOwnerFeature");
        // `ownerGet` is how every owner page reads from the API.
        const fetchAt = body.indexOf("ownerGet");
        if (gate >= 0 && fetchAt >= 0 && fetchAt < gate) {
          offenders.push(`${href} fetches before it gates`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("governs a route the owner navigation actually has", () => {
    // The claim org-features.ts makes about itself. A feature pointing at a
    // page the rail never links is a toggle nobody can see the effect of, and
    // usually means a route was renamed on one side only.
    const navHrefs = new Set(OWNER_NAV_ITEMS.map((i) => i.href));
    const orphans = ORG_FEATURES.filter((f) => !f.hrefs.some((h) => navHrefs.has(h))).map(
      (f) => f.id,
    );
    expect(orphans).toEqual([]);
  });

  it("hides a page from the rail when its feature is off", () => {
    // The other half of the same promise: the gate stops a bookmark, and the
    // nav filter stops the link appearing at all. Testing them together is
    // what makes "switched off" mean one thing.
    const modules = ["aura", "crm", "call_intel", "wasi"];
    const all = ORG_FEATURES.map((f) => f.id);
    const withInvoices = ownerNavItemsFor("owner", false, true, true, {
      modules,
      features: all,
    }).map((i) => i.href);
    const withoutInvoices = ownerNavItemsFor("owner", false, true, true, {
      modules,
      features: all.filter((f) => f !== "invoices"),
    }).map((i) => i.href);

    expect(withInvoices).toContain("/owner/invoices");
    expect(withoutInvoices).not.toContain("/owner/invoices");
    // Nothing ELSE moved - a feature toggle must not disturb the rest of the
    // rail, which is the bug an over-broad prefix match would produce.
    expect(withoutInvoices).toEqual(withInvoices.filter((h) => h !== "/owner/invoices"));
  });

  it("leaves the rail untouched when no entitlement is passed", () => {
    // The compatibility promise `Entitlement` documents: every caller that
    // existed before migration 0093 keeps the module-only answer, so adding
    // this axis changed nothing for anyone who has not opted in.
    expect(ownerNavItemsFor("owner", false, true, true)).toEqual(
      ownerNavItemsFor("owner", false, true, true, undefined),
    );
  });
});
