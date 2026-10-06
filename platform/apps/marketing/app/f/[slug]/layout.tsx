import type { ReactNode } from "react";

/**
 * A hosted form carries none of the site's chrome.
 *
 * ── WHY THIS IS A `<style>` AND NOT A SECOND ROOT LAYOUT ───────────────────
 *
 * Next renders `app/layout.tsx` around every route, and it emits the site
 * header, the footer and the skip link. On this route all three are wrong: the
 * page is a tenant's form, not ours, and in the `<script>`/`<iframe>` embed it
 * is drawn inside somebody else's page - where an Aura header and a footer
 * full of our marketing links would be an advert we inserted into a customer's
 * site without asking.
 *
 * The clean fix is two root layouts (`app/(site)/layout.tsx` and
 * `app/(embed)/layout.tsx`), which means moving the existing root layout. That
 * is a change to a file every other page on this site depends on, for the sake
 * of one route, so it is not this build's to make. Three selectors scoped to
 * the three elements that layout renders as direct children of `<body>` do the
 * same job and are reversible in one commit.
 *
 * It is `<style>` and not a Tailwind class because the nodes being hidden are
 * ANCESTORS' siblings - there is no class this subtree can carry that reaches
 * them. Unlayered, so it beats Tailwind's utilities whatever the source order,
 * which is the same property globals.css's focus rule documents (and the same
 * trap: no `border-radius` or anything else that leaks).
 *
 * Followed up in the report: when somebody splits the root layout, delete this.
 */
const HIDE_SITE_CHROME = `
  body > header.mk-header,
  body > footer,
  body > a[href="#main"] { display: none !important; }
  body > main { min-height: 100dvh; }
`;

export default function HostedFormLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: HIDE_SITE_CHROME }} />
      {children}
    </>
  );
}
