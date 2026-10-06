import type { Metadata } from "next";
import { loadForm } from "./api";
import { HostedForm } from "./form-renderer";

/**
 * A tenant's own form, hosted here (migration 0161, Build docs/39 §16).
 *
 * ── ONE RENDERER, THREE WAYS IN ────────────────────────────────────────────
 *
 * This page IS the form. The `<iframe>` snippet points at it with `?embed=1`;
 * the `<script>` snippet injects that iframe. There is deliberately no second
 * rendering engine - a JS widget rebuilding the fields inside the host page
 * would be a second validator, a second conditional-logic evaluator and a
 * second consent renderer, and the drift would show up as numbers collected
 * under a sentence nobody can reproduce.
 *
 * ── DYNAMIC, AND NOT CACHED ────────────────────────────────────────────────
 *
 * Every other page on this site is statically rendered at build time. This one
 * cannot be: the content is a database row that a tenant edits, and a cached
 * copy would keep showing a question they deleted - or keep accepting a form
 * they closed. `force-dynamic` plus `cache: "no-store"` in api.ts.
 */
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * `noindex`, and this is a decision rather than caution.
 *
 * The page is a customer's lead form on OUR domain. Indexing it would put
 * their campaign landing pages into search results under sirahagents.com,
 * compete with the tenant's own site for their own brand terms, and leave a
 * closed form's thank-you text in Google's cache for months. The link is for
 * sharing, not for ranking.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const lookup = await loadForm(slug);
  return {
    title: lookup.state === "ok" ? lookup.form.name : "Form",
    robots: { index: false, follow: false },
    // No canonical and no OpenGraph image: this page is not ours to promote.
    alternates: {},
  };
}

export default async function HostedFormPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const lookup = await loadForm(slug);

  if (lookup.state !== "ok") {
    // Deliberately NOT `notFound()`. That renders the marketing site's 404,
    // which offers a visitor who came for a tenant's form a tour of our
    // product - and inside an iframe on the tenant's own page it would be an
    // advert we inserted into their site. One quiet sentence instead.
    return (
      <Shell>
        <p className="text-base text-text">
          {lookup.state === "missing"
            ? "This form is no longer taking responses."
            : "This form can’t be loaded right now. Please try again in a moment."}
        </p>
      </Shell>
    );
  }

  const utm: Record<string, string> = {};
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
    const value = first(query[key]);
    if (value) utm[key] = value.slice(0, 200);
  }

  // Hidden fields are prefilled from the query string, which is how a tenant
  // gets the campaign, the landing page variant or a partner code onto the
  // lead without writing any JavaScript: `/f/diwali?store=chennai` fills a
  // hidden field keyed `store`. The field must exist - an unknown parameter
  // sets nothing - so this cannot be used to inject a value into a field the
  // form does not have.
  const prefill: Record<string, string> = {};
  for (const field of lookup.form.definition.fields) {
    if (field.type !== "hidden") continue;
    const value = first(query[field.key]) ?? field.defaultValue ?? null;
    if (value) prefill[field.key] = value.slice(0, 400);
  }

  return (
    <Shell embed={first(query.embed) === "1"}>
      <HostedForm
        form={lookup.form}
        embed={first(query.embed) === "1"}
        utm={utm}
        prefill={prefill}
      />
    </Shell>
  );
}

/**
 * The ground the form sits on.
 *
 * Padded and centred on its own, flush inside an embed: the host page has
 * already decided where this sits and how wide it is, and a second set of
 * margins inside the iframe reads as a misaligned box. 16px side gutters at
 * phone width either way.
 */
function Shell({ children, embed = false }: { children: React.ReactNode; embed?: boolean }) {
  return (
    <div className={embed ? "px-4 py-4" : "mx-auto w-full max-w-xl px-4 py-10 sm:py-16"}>{children}</div>
  );
}
