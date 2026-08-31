import Link from "next/link";
import { Container } from "@/components/ui/layout";
import { Prose } from "@/components/ui/content";
import { formatLegalDate } from "@/lib/legal";

/**
 * Shared chrome for /privacy, /terms and /dpa.
 *
 * One shell for all three so the effective date, the "last updated" line and
 * the counsel-review posture cannot drift between documents - a privacy policy
 * dated differently from the DPA it references is the kind of small
 * inconsistency that a buyer's legal team treats as a signal about everything
 * else.
 *
 * `LAST_SUBSTANTIVE_EDIT` is the date the WORDING last changed, and is
 * deliberately a constant rather than a build timestamp. A "last updated" that
 * moves every deploy tells the reader nothing and quietly claims a review that
 * did not happen.
 */
const LAST_SUBSTANTIVE_EDIT = "2026-08-08";

export function LegalDocument({
  eyebrow,
  title,
  lead,
  effectiveDate,
  children,
}: {
  eyebrow: string;
  title: string;
  lead: React.ReactNode;
  effectiveDate: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Container className="pt-12 sm:pt-16">
        <div className="max-w-3xl">
          <p className="text-sm font-medium text-accent-text">{eyebrow}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">
            {title}
          </h1>
          <p className="mt-6 text-xl text-text-muted text-pretty">{lead}</p>

          <dl className="mt-8 flex flex-wrap gap-x-8 gap-y-2 border-t border-border pt-5 text-sm">
            <div className="flex gap-2">
              <dt className="text-text-muted">Effective</dt>
              <dd className="font-medium text-text">{formatLegalDate(effectiveDate)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-text-muted">Last updated</dt>
              <dd className="font-medium text-text">
                {formatLegalDate(LAST_SUBSTANTIVE_EDIT)}
              </dd>
            </div>
          </dl>
        </div>
      </Container>

      <Container className="pb-16 pt-10 sm:pb-24">
        <LegalProse>{children}</LegalProse>

        <div className="mt-16 max-w-3xl border-t border-border pt-6 text-sm text-text-muted">
          <p>
            Related: <TextRef href="/consent">call recording and consent</TextRef> ·{" "}
            <TextRef href="/security">how we handle your data</TextRef>
          </p>
        </div>
      </Container>
    </>
  );
}

/**
 * `Prose` plus the table, definition-list and anchor styling these documents
 * need and the marketing pages do not.
 *
 * Tables scroll inside their own container rather than widening the page. A
 * three-column sub-processor table is the widest thing on the site and would
 * otherwise be the one element that makes the whole document scroll sideways on
 * a phone - on a page whose entire job is to be read carefully.
 */
export function LegalProse({ children }: { children: React.ReactNode }) {
  return (
    <Prose
      className={[
        "[&_h2]:scroll-mt-24 [&_h3]:scroll-mt-24",
        "[&_table]:w-full [&_table]:border-collapse [&_table]:text-base",
        "[&_thead_th]:border-b [&_thead_th]:border-border-strong [&_thead_th]:pb-2 [&_thead_th]:pr-4",
        "[&_thead_th]:text-left [&_thead_th]:font-semibold [&_thead_th]:text-text",
        "[&_tbody_td]:border-b [&_tbody_td]:border-border [&_tbody_td]:py-2.5 [&_tbody_td]:pr-4",
        "[&_tbody_td]:align-top",
        "[&_a]:text-accent-text [&_a]:underline [&_a]:underline-offset-2",
        "[&_dt]:font-medium [&_dt]:text-text",
      ].join(" ")}
    >
      {children}
    </Prose>
  );
}

/** A table that scrolls rather than stretching the page. */
export function LegalTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 overflow-x-auto">
      <table>{children}</table>
    </div>
  );
}

function TextRef({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-accent-text underline underline-offset-2">
      {children}
    </Link>
  );
}

/**
 * A statement the reader might not expect and would rather hear from us.
 *
 * Used for the Seoul disclosure and the handset-encryption default. Both are
 * facts a buyer could find uncomfortable, and both are called out visually on
 * purpose: burying an inconvenient truth in body text is technically disclosure
 * and practically concealment.
 */
export function Candid({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-lg border border-border-strong bg-bg-subtle p-5">
      <p className="font-semibold text-text">{title}</p>
      <div className="mt-2 text-base [&_p]:mt-3 [&_p:first-child]:mt-0">{children}</div>
    </div>
  );
}
