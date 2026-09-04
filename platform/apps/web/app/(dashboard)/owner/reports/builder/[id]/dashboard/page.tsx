import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Palette, ReportDoc } from "@aura/shared";
import { ownerGet } from "@/lib/owner-context";
import { LiveDashboard } from "./live-dashboard";

export const metadata: Metadata = { title: "Dashboard - Aura" };

interface DetailResponse {
  report: { id: string; name: string };
  doc: ReportDoc;
}

/**
 * A report, full screen.
 *
 * ── DELIBERATELY OUTSIDE `(owner)/` ────────────────────────────────────────
 *
 * `(owner)/layout.tsx` wraps every page under `/owner/...` with the console
 * sidebar - correct for the report editor and even for the print route (which
 * only hides it with `@media print`). A screen meant to run unattended on an
 * office TV, or inside a kiosk webview, must never show that chrome, not even
 * before Fullscreen is engaged. So this lives in its own top-level route
 * group: same URL family (`/owner/reports/builder/[id]/dashboard`), but
 * nothing above it in the file tree attaches a layout, so only the root
 * shell (fonts, ConfirmProvider) wraps it.
 *
 * ── DATA ────────────────────────────────────────────────────────────────
 *
 * Auth and the first paint reuse exactly what the report editor does:
 * `ownerGet` resolves the session (returns null, and this 404s, for anyone
 * not signed in - matching `[id]/page.tsx`'s "don't distinguish gone vs no
 * access"), and `/v1/report-builder/:id` is the same detail call. The optional
 * `?token=` forwards the report's read-only share link for a session that
 * isn't its owner/editor/viewer. Live data after that comes from
 * `renderReportAction`, the same `/render` endpoint the print route uses -
 * its own comment already calls this "the shared read-only view".
 */
export default async function DashboardViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;

  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const [detail, palettes] = await Promise.all([
    ownerGet<DetailResponse>(`/v1/report-builder/${id}${query}`),
    ownerGet<{ palettes: Palette[] }>("/v1/report-builder/palettes"),
  ]);
  if (!detail) notFound();

  return (
    <LiveDashboard
      reportId={id}
      token={token}
      name={detail.report.name}
      initialDoc={detail.doc}
      customPalettes={palettes?.palettes ?? []}
    />
  );
}
