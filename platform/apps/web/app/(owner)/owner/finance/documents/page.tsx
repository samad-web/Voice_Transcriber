import type { Metadata } from "next";
import Link from "next/link";
import {
  DOCUMENT_GROUP_LABELS,
  type DocumentExpiryStatus,
  type DocumentGroup,
  EXPIRY_STATUS_LABELS,
  formatBytes,
  formatDateKey,
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
import { ownerTry, requireFeature } from "@/lib/owner-context";

export const metadata: Metadata = { title: "Documents" };

interface VaultDocument {
  id: string;
  category: { id: string; code: string; label: string; group: DocumentGroup; groupLabel: string };
  title: string;
  docNumber: string | null;
  fileName: string;
  bytes: number;
  version: number;
  issuedOn: string | null;
  expiresOn: string | null;
  expiryStatus: DocumentExpiryStatus;
  daysUntilExpiry: number | null;
  superseded: boolean;
  owner: { id: string; name: string | null } | null;
  uploadedBy: string | null;
  createdAt: string;
}

interface DocumentsData {
  documents: VaultDocument[];
  today: string;
  counts: { expired: number; expiring: number; valid: number; noExpiry: number };
}

interface GapsData {
  gaps: Array<{ categoryCode: string; label: string; group: DocumentGroup; groupLabel: string }>;
  profileSet: boolean;
}

/**
 * §1's document vault
 * (Build docs/indian-business-finance-documents-cycles-import).
 *
 * ── THE MISSING LIST IS THE POINT OF THE SCREEN ─────────────────────────────
 *
 * §1's opening instruction is to group documents into categories "so each can
 * carry an expiry date, an owner, and a reminder". The reason that matters is
 * not filing - it is that a business discovers a missing GST certificate or a
 * lapsed trade licence at the worst possible moment. So the gaps come FIRST on
 * this page and the inventory second.
 *
 * The gap list only names SINGLETON categories - the things a business should
 * hold exactly one current copy of. "No vendor bill this week" is not a gap,
 * and a list that said so would have forty rows nobody can clear.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * Employee documents. Offer letters, signed contracts, NDAs and amendments
 * live on the organization chart (migration 0178), behind that module's own
 * permission. The boundary is about access rather than tidiness: putting
 * somebody's contract here would widen who can read it and split the audit
 * trail in two. Both stores log every read to the same `document_access_log`.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/finance/documents");

  const sp = await searchParams;
  const rawStatus = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = (["expired", "expiring", "valid", "no_expiry"] as const).includes(
    rawStatus as never,
  )
    ? (rawStatus as DocumentExpiryStatus)
    : undefined;

  const [docs, gaps] = await Promise.all([
    ownerTry<DocumentsData>(`/v1/finance/documents${status ? `?status=${status}` : ""}`),
    ownerTry<GapsData>("/v1/finance/documents/gaps"),
  ]);

  if (!docs.ok) {
    return (
      <>
        <PageHeader title="Documents" context="Sales" />
        <LoadFailure what="the document vault" failure={docs} />
      </>
    );
  }

  const data = docs.data;
  const gapList = gaps.ok ? gaps.data.gaps : [];
  const profileSet = gaps.ok ? gaps.data.profileSet : false;

  const tone = (s: DocumentExpiryStatus) =>
    s === "expired" ? "danger" : s === "expiring" ? "solid" : s === "valid" ? "outline" : "muted";

  // Grouped for rendering, in §1's own order, empty groups dropped.
  const order = Object.keys(DOCUMENT_GROUP_LABELS) as DocumentGroup[];
  const grouped = order
    .map((group) => ({
      group,
      label: DOCUMENT_GROUP_LABELS[group],
      documents: data.documents.filter((d) => d.category.group === group),
    }))
    .filter((g) => g.documents.length > 0);

  const filters: Array<{ key: DocumentExpiryStatus | "all"; label: string; count: number }> = [
    { key: "all", label: "Everything", count: data.documents.length },
    { key: "expired", label: "Expired", count: data.counts.expired },
    { key: "expiring", label: "Expiring soon", count: data.counts.expiring },
    { key: "valid", label: "Valid", count: data.counts.valid },
    { key: "no_expiry", label: "No expiry", count: data.counts.noExpiry },
  ];

  return (
    <>
      <PageHeader
        title="Documents"
        context="Sales"
        description="Registrations, licences, agreements and tax records - with a reminder before each expiry."
        actions={
          <div className="flex items-center gap-3">
            <Link
              href="/owner/finance/compliance"
              className="text-xs text-text-muted underline hover:text-text"
            >
              Compliance calendar
            </Link>
            <Link href="/owner/finance" className="text-xs text-text-muted underline hover:text-text">
              Finance overview
            </Link>
          </div>
        }
      />

      {data.counts.expired > 0 ? (
        <Card>
          <p className="text-sm text-text-muted">
            <strong className="text-text">
              {data.counts.expired} document{data.counts.expired === 1 ? "" : "s"} expired.
            </strong>{" "}
            Upload the renewed copy as a new version and the old one stays on file - a replaced
            document is never deleted, because the one time anybody needs the superseded version is
            a dispute about what was in force.
          </p>
        </Card>
      ) : null}

      {gapList.length > 0 ? (
        <Card>
          <h2 className="text-sm font-medium text-text">Documents you do not have on file</h2>
          <p className="mt-1 text-xs text-text-muted">
            {profileSet
              ? "Based on your legal form and registrations."
              : "Based on the registrations you have. Set your legal form in settings to narrow this to what actually applies to you."}
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {gapList.map((gap) => (
              <li
                key={gap.categoryCode}
                className="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted"
              >
                {gap.label}
                <span className="ml-1.5 text-text-subtle">{gap.groupLabel}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <nav aria-label="Filter by expiry" className="flex flex-wrap gap-2 text-xs">
        {filters.map((f) => {
          const href =
            f.key === "all" ? "/owner/finance/documents" : `/owner/finance/documents?status=${f.key}`;
          const active = f.key === "all" ? status === undefined : status === f.key;
          return (
            <Link
              key={f.key}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md border px-2.5 py-1.5 ${
                active ? "border-accent text-text" : "border-border text-text-muted hover:text-text"
              }`}
            >
              {f.label} ({f.count})
            </Link>
          );
        })}
      </nav>

      {data.documents.length === 0 ? (
        <EmptyState
          title={status ? "Nothing matches that filter" : "The vault is empty"}
          description={
            status
              ? "No document in the vault is in that state."
              : "Upload your registration certificates, licences, agreements and tax records here. Anything with an expiry gets a reminder before it lapses."
          }
        />
      ) : (
        grouped.map((group) => (
          <Card key={group.group}>
            <h2 className="mb-3 text-sm font-medium text-text">{group.label}</h2>
            <Table caption={`${group.label} documents`}>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Document</TableHeaderCell>
                  <TableHeaderCell>Number</TableHeaderCell>
                  <TableHeaderCell>Expires</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Owner</TableHeaderCell>
                  <TableHeaderCell>File</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {group.documents.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell>
                      <div className="font-medium text-text">{doc.title}</div>
                      <div className="text-xs text-text-muted">
                        {doc.category.label}
                        {doc.version > 1 ? ` · version ${doc.version}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-text-muted">{doc.docNumber ?? "—"}</TableCell>
                    <TableCell>
                      {doc.expiresOn ? (
                        <>
                          <div>{formatDateKey(doc.expiresOn)}</div>
                          <div className="text-xs text-text-muted">
                            {doc.daysUntilExpiry === null
                              ? null
                              : doc.daysUntilExpiry < 0
                                ? `${Math.abs(doc.daysUntilExpiry)} days ago`
                                : doc.daysUntilExpiry === 0
                                  ? "Today"
                                  : `in ${doc.daysUntilExpiry} days`}
                          </div>
                        </>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusChip tone={tone(doc.expiryStatus)}>
                        {EXPIRY_STATUS_LABELS[doc.expiryStatus]}
                      </StatusChip>
                    </TableCell>
                    <TableCell className="text-text-muted">{doc.owner?.name ?? "—"}</TableCell>
                    <TableCell>
                      {/* The file name and size, NOT a link. A document is
                          fetched through a 300-second signed URL that the API
                          mints per request and logs - so there is no durable
                          href to put in an anchor here, which is the whole
                          point of storing a key rather than a URL. */}
                      <div className="text-xs text-text-muted">{doc.fileName}</div>
                      <div className="text-xs text-text-subtle">{formatBytes(doc.bytes)}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ))
      )}
    </>
  );
}
