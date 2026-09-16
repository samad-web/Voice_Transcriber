import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReportDoc } from "@aura/shared";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";
import { PrintableReport } from "./printable-report";

export const metadata: Metadata = { title: "Print report" };

interface RenderResponse {
  name: string;
  failures: string[];
  snapshot: {
    doc: ReportDoc;
    widgets: Record<
      string,
      {
        rows: Array<Record<string, string | number | null>>;
        dimensionKeys: string[];
        measureKeys: string[];
        truncated: boolean;
        error?: string;
      }
    >;
    generatedAt: string;
  };
}

/**
 * The PDF.
 *
 * ── DESIGN DOC D1, IN ONE PAGE ──────────────────────────────────────────
 *
 * There is no PDF library here and no headless browser behind it. This route
 * renders the report as ordinary HTML with a print stylesheet and the client
 * component calls `window.print()`. The reader's own browser writes the PDF,
 * which means:
 *
 *   * the text is TEXT - selectable, searchable, and readable by a screen
 *     reader, which `html2canvas` output is not;
 *   * the fonts are the fonts, because the engine laying the page out is the
 *     engine that already has them;
 *   * page breaks are decided by `break-inside: avoid` on every tile, so a
 *     chart cannot be sliced across two sheets (acceptance criterion 5).
 *
 * What it costs, stated: the OS print dialog rather than a file appearing in
 * Downloads, and no way to render a PDF without a browser - which is why a
 * scheduled run freezes DATA (`report_runs.snapshot`) rather than producing a
 * document. Swapping in Puppeteer later means rendering this same route
 * server-side; nothing else changes.
 *
 * ── WHY THIS RENDERS SERVER-SIDE AND FULLY ──────────────────────────────
 *
 * `POST /render` runs every widget in one call, so the page arrives complete.
 * A print view that fetched per widget would race `window.print()` and produce
 * a PDF of loading spinners - the single most common way a print feature ships
 * broken.
 */
export default async function PrintReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const owner = await getOwner();
  if (!owner) notFound();

  // A POST, so this cannot go through `ownerGet`. Same credential path as
  // every other owner call - the admin key is added server-side and the
  // tenant is re-derived from the session, never from the URL.
  let rendered: RenderResponse | null = null;
  try {
    const res = await fetch(`${API_URL}/v1/report-builder/${id}/render`, {
      method: "POST",
      headers: orgHeaders(owner.membership.orgId, {
        ownerRole: owner.membership.ownerRole,
        userId: owner.userId,
      }),
      cache: "no-store",
      body: "{}",
    });
    if (res.ok) rendered = (await res.json()) as RenderResponse;
  } catch {
    rendered = null;
  }

  if (!rendered) notFound();

  return (
    <PrintableReport
      name={rendered.name}
      doc={rendered.snapshot.doc}
      widgets={rendered.snapshot.widgets}
      generatedAt={rendered.snapshot.generatedAt}
      failures={rendered.failures}
      orgName={owner.membership.orgName}
    />
  );
}
