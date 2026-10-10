import type { Metadata } from "next";
import Link from "next/link";
import {
  DEFAULT_TIME_ZONE,
  formatDateTime,
  formatDateKey,
  IMPORT_ENTITY_LABELS,
  IMPORT_SOURCE_LABELS,
  type ImportEntity,
} from "@aura/shared";
import {
  Card,
  EmptyState,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry, requireFeature } from "@/lib/owner-context";
import { RollbackButton } from "./rollback-button";

export const metadata: Metadata = { title: "Import history" };

interface HistoryJob {
  id: string;
  entity: ImportEntity;
  status: string;
  mode: string;
  date_order: string | null;
  source: string | null;
  file_name: string | null;
  sheet_name: string | null;
  total_rows: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  failed_count: number;
  duplicate_count: number;
  created_at: string;
  finished_at: string | null;
  rolled_back_at: string | null;
  created_by_name: string | null;
  template_name: string | null;
}

/**
 * §3's import history page: "files, status, counts, mapping used, and
 * one-click rollback."
 *
 * ── THE UNDO IS NOT ONE CLICK, AND THAT IS DELIBERATE ───────────────────────
 *
 * §3 asks for one-click rollback. This asks for a reason first, for two
 * reasons of its own:
 *
 * A finance rollback is not a delete. A payment is REVERSED - §6.3's MUST is
 * "never edit or delete a posted payment or ledger row" - which writes a
 * reversing ledger entry that stays on the books forever. The reason goes on
 * that entry, and a blank one leaves an auditor looking at a correction nobody
 * can explain.
 *
 * And a rollback can be PARTIALLY refused: an approved expense is left alone,
 * a reconciled statement line is left alone, and a locked period refuses the
 * whole thing. A button that reported "undone" without saying what it could
 * not undo would be the worst of both.
 */
export default async function ImportHistoryPage() {
  await requireFeature("/owner/import");

  // ── EVERY TIMESTAMP HERE IS IN THE WORKSPACE'S ZONE ────────────────────
  //
  // Not the server's and not the viewer's. This console runs in Mumbai
  // against a database in Seoul, and `toLocaleString()` with no zone formats
  // in whichever of those the code happens to be running in - so an import
  // run at 11pm IST would be dated tomorrow. `console-time.test.ts` scans for
  // exactly this and caught the first version of this page.
  const [owner, history] = await Promise.all([
    getOwner(),
    ownerTry<{ jobs: HistoryJob[] }>("/v1/import/jobs?limit=50"),
  ]);
  const zone = owner?.membership.reportingTimezone ?? DEFAULT_TIME_ZONE;

  if (!history.ok) {
    return (
      <>
        <PageHeader title="Import history" context="Leads" />
        <LoadFailure what="the import history" failure={history} />
      </>
    );
  }

  const jobs: HistoryJob[] = history.data.jobs;

  const tone = (status: string) =>
    status === "done"
      ? "outline"
      : status === "failed"
        ? "danger"
        : status === "rolled_back"
          ? "muted"
          : status === "staged"
            ? "solid"
            : "muted";

  const label = (status: string) =>
    status === "rolled_back"
      ? "Undone"
      : status === "staged"
        ? "Not applied"
        : status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <>
      <PageHeader
        title="Import history"
        context="Leads"
        description="Every file imported into this workspace, what it did, and how to undo it."
        actions={
          <Link href="/owner/import" className="text-xs text-text-muted underline hover:text-text">
            New import
          </Link>
        }
      />

      {jobs.length === 0 ? (
        <EmptyState
          title="Nothing imported yet"
          description="Once you import a file it shows up here, with the option to undo the whole batch."
        />
      ) : (
        <Card>
          <Table caption="Imports, most recent first">
            <TableHead>
              <TableRow>
                <TableHeaderCell>File</TableHeaderCell>
                <TableHeaderCell>What</TableHeaderCell>
                <TableHeaderCell>Result</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Who</TableHeaderCell>
                <TableHeaderCell>Undo</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <div className="font-medium text-text">{job.file_name ?? "Pasted rows"}</div>
                    <div className="text-xs text-text-muted">
                      {job.sheet_name ? `${job.sheet_name} · ` : ""}
                      {formatDateTime(job.created_at, zone)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{IMPORT_ENTITY_LABELS[job.entity] ?? job.entity}</div>
                    <div className="text-xs text-text-muted">
                      {job.source
                        ? (IMPORT_SOURCE_LABELS[job.source as keyof typeof IMPORT_SOURCE_LABELS] ??
                          job.source)
                        : null}
                      {job.template_name ? ` · ${job.template_name}` : ""}
                      {/* The resolved date format, which is the single most
                          consequential decision in a finance import and the
                          one somebody asks about six weeks later. */}
                      {job.date_order ? ` · dates read ${job.date_order}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <div>
                      {job.inserted_count} imported
                      {job.updated_count > 0 ? `, ${job.updated_count} updated` : ""}
                    </div>
                    <div className="text-xs text-text-muted">
                      of {job.total_rows} row{job.total_rows === 1 ? "" : "s"}
                      {job.duplicate_count > 0 ? ` · ${job.duplicate_count} duplicate` : ""}
                      {job.failed_count > 0 ? ` · ${job.failed_count} failed` : ""}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusChip tone={tone(job.status)}>{label(job.status)}</StatusChip>
                    {job.rolled_back_at ? (
                      <div className="text-xs text-text-muted">
                        {formatDateKey(job.rolled_back_at.slice(0, 10))}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-text-muted">{job.created_by_name ?? "—"}</TableCell>
                  <TableCell>
                    {job.status === "done" && job.inserted_count > 0 ? (
                      <RollbackButton
                        jobId={job.id}
                        entityLabel={IMPORT_ENTITY_LABELS[job.entity] ?? job.entity}
                        rowCount={job.inserted_count}
                      />
                    ) : (
                      <span className="text-xs text-text-muted">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Card>
        <p className="text-sm text-text-muted">
          <strong className="text-text">What an undo can and cannot reach.</strong> Statement lines
          are removed. Expenses are removed while they are still waiting for approval; an approved
          one is left alone, because it is already in the margin. A payment is{" "}
          <em>reversed</em> rather than deleted - the ledger keeps both entries and nets to zero -
          and a payment dated into a locked month cannot be touched at all, because the books are
          closed on that month.
        </p>
      </Card>
    </>
  );
}
