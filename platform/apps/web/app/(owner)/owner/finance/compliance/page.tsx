import type { Metadata } from "next";
import Link from "next/link";
import {
  COMPLIANCE_STATUS_LABELS,
  type ComplianceStatus,
  FREQUENCY_LABELS,
  type ComplianceFrequency,
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

export const metadata: Metadata = { title: "Compliance calendar" };

interface Filing {
  id: string;
  itemCode: string;
  name: string;
  authority: string;
  formName: string | null;
  period: { from: string; to: string; label: string };
  dueOn: string;
  dueOnOverridden: boolean;
  status: ComplianceStatus;
  /** Generated after it was already due - so nobody knows whether it was filed. */
  backFilled: boolean;
  daysUntilDue: number | null;
  filedOn: string | null;
  waivedReason: string | null;
  amount: string | null;
  currency: string;
  document: { id: string; title: string | null } | null;
  reference: string | null;
  assignee: { id: string; name: string | null } | null;
  notes: string | null;
}

interface FilingsData {
  filings: Filing[];
  window: { from: string; to: string; label: string };
  today: string;
  counts: Record<string, number>;
}

interface ItemsData {
  items: Array<{
    id: string;
    code: string;
    name: string;
    authority: string;
    formName: string | null;
    frequency: ComplianceFrequency;
    dueRuleValid: boolean;
    reminderOffsets: number[];
    notes: string | null;
    verifyWithCa: boolean;
    enabled: boolean;
  }>;
}

interface ProfileData {
  entityType: string | null;
  registrations: string[];
  fyStartMonth: number;
  fiscalYear: { startYear: number; label: string; from: string; to: string };
  today: string;
}

/**
 * §2's compliance calendar
 * (Build docs/indian-business-finance-documents-cycles-import).
 *
 * ── THE BANNER IS NOT DECORATION ────────────────────────────────────────────
 *
 * §2 contains a blockquote that is really a product requirement:
 *
 *   "Verify with your CA. Treat all due dates and thresholds in this document
 *    as defaults. Dates, thresholds and forms change by budget, notification
 *    and extension."
 *
 * So this page says so, and says it per ROW rather than only at the top: a
 * banner at the top of a page is read once and then never again, while a
 * marker on the filing somebody is about to act on is read every time. A date
 * that is wrong and labelled "check this" is a prompt; a date that is wrong
 * and silent is a penalty.
 *
 * ── AND EVERY STATUS HERE WAS COMPUTED A MOMENT AGO ─────────────────────────
 *
 * Nothing on this screen reads a stored status, because there is no column to
 * read - 0181 asserts that `compliance_filings` has none. The API derives
 * upcoming/due-soon/overdue/filed/waived from the ORG's today on each request.
 * The scar is `invoices.status`, which has allowed `'overdue'` since migration
 * 0060 with nothing ever setting it.
 */
export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/finance/compliance");

  const sp = await searchParams;
  const rawStatus = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  // `back_filled` is a FILTER, not a status - the status of those rows is
  // still `overdue`. It is offered separately so "Overdue" means work somebody
  // actually missed.
  const status = (
    ["overdue", "back_filled", "due_soon", "upcoming", "filed", "waived"] as const
  ).includes(rawStatus as never)
    ? (rawStatus as ComplianceStatus | "back_filled")
    : undefined;

  const [filings, items, profile] = await Promise.all([
    ownerTry<FilingsData>(`/v1/finance/compliance/filings${status ? `?status=${status}` : ""}`),
    ownerTry<ItemsData>("/v1/finance/compliance/items"),
    ownerTry<ProfileData>("/v1/finance/compliance/profile"),
  ]);

  if (!filings.ok) {
    return (
      <>
        <PageHeader title="Compliance calendar" context="Sales" />
        <LoadFailure what="the compliance calendar" failure={filings} />
      </>
    );
  }

  const data = filings.data;
  const itemList = items.ok ? items.data.items : [];
  const fy = profile.ok ? profile.data.fiscalYear : null;
  const itemByCode = new Map(itemList.map((i) => [i.code, i]));

  // Nothing set up yet. A tenant arrives here with an empty calendar, so the
  // page has to explain the ONE action that fills it rather than showing an
  // empty table and leaving them to find a settings screen.
  if (data.filings.length === 0 && itemList.length === 0) {
    return (
      <>
        <PageHeader
          title="Compliance calendar"
          context="Sales"
          description="GST, TDS, PF, advance tax and the annual filings, with a reminder before each one."
        />
        <EmptyState
          title="Your calendar has not been set up yet"
          description={
            "Tell us the shape of your business and we will fill in the filings that apply to it - " +
            "monthly GST and TDS, the quarterly returns, advance tax and the year-end work. " +
            "Every date is a default you can change, and your CA should confirm them."
          }
        />
        <Card>
          <p className="text-sm text-text-muted">
            Set this up from{" "}
            <Link href="/owner/account/time" className="underline hover:text-text">
              Time &amp; location
            </Link>{" "}
            (for your financial year) and then seed the calendar from the compliance API. The
            financial year currently reads{" "}
            <strong className="text-text">{fy ? fy.label : "FY 2026-27"}</strong>.
          </p>
        </Card>
      </>
    );
  }

  const statusTone = (s: ComplianceStatus) =>
    s === "overdue"
      ? "danger"
      : s === "due_soon"
        ? "solid"
        : s === "filed"
          ? "outline"
          : s === "waived"
            ? "muted"
            : "muted";

  const counts = data.counts;
  const filters: Array<{
    key: ComplianceStatus | "back_filled" | "all";
    label: string;
    count: number;
  }> = [
    { key: "all", label: "Everything", count: data.filings.length },
    { key: "overdue", label: "Overdue", count: counts.overdue ?? 0 },
    { key: "back_filled", label: "Before you started", count: counts.backFilled ?? 0 },
    { key: "due_soon", label: "Due soon", count: counts.dueSoon ?? 0 },
    { key: "upcoming", label: "Upcoming", count: counts.upcoming ?? 0 },
    { key: "filed", label: "Filed", count: counts.filed ?? 0 },
    { key: "waived", label: "Not applicable", count: counts.waived ?? 0 },
  ];

  return (
    <>
      <PageHeader
        title="Compliance calendar"
        context="Sales"
        description={
          fy
            ? `${fy.label}, running ${formatDateKey(fy.from)} to ${formatDateKey(fy.to)}.`
            : "Everything this business has to file, and when."
        }
        actions={
          <div className="flex items-center gap-3">
            <Link
              href="/owner/finance/close"
              className="text-xs text-text-muted underline hover:text-text"
            >
              Month-end close
            </Link>
            <Link href="/owner/finance" className="text-xs text-text-muted underline hover:text-text">
              Finance overview
            </Link>
          </div>
        }
      />

      {/* §2's callout, verbatim in substance. Above the table rather than
          below it, because it changes how the dates below should be read. */}
      <Card>
        <p className="text-sm text-text-muted">
          <strong className="text-text">Confirm these dates with your CA.</strong> Due dates,
          thresholds and forms change with the budget, with notifications and with extensions.
          Every date here is a default you can edit, and a filing can be moved or marked not
          applicable.
        </p>
      </Card>

      <nav aria-label="Filter by status" className="flex flex-wrap gap-2 text-xs">
        {filters.map((f) => {
          const href = f.key === "all" ? "/owner/finance/compliance" : `/owner/finance/compliance?status=${f.key}`;
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

      {data.filings.length === 0 ? (
        <EmptyState
          title="Nothing here"
          description="No filing in this financial year matches that filter."
        />
      ) : (
        <Card>
          <Table caption={`Compliance filings for ${data.window.label}`}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Filing</TableHeaderCell>
                <TableHeaderCell>Period</TableHeaderCell>
                <TableHeaderCell>Due</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Owner</TableHeaderCell>
                <TableHeaderCell>Proof</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.filings.map((filing) => {
                const item = itemByCode.get(filing.itemCode);
                return (
                  <TableRow key={filing.id}>
                    <TableCell>
                      <div className="font-medium text-text">{filing.name}</div>
                      <div className="text-xs text-text-muted">
                        {filing.authority}
                        {filing.formName ? ` · ${filing.formName}` : ""}
                        {item ? ` · ${FREQUENCY_LABELS[item.frequency]}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>{filing.period.label}</TableCell>
                    <TableCell>
                      <div>{formatDateKey(filing.dueOn)}</div>
                      <div className="text-xs text-text-muted">
                        {/* The relative phrase, which is the number people act
                            on. Negative days read as "late by", because "in -7
                            days" is a sentence nobody parses at a glance. */}
                        {filing.daysUntilDue === null
                          ? null
                          : filing.backFilled && filing.daysUntilDue < 0
                            ? "Before this calendar existed"
                            : filing.daysUntilDue < 0
                              ? `${Math.abs(filing.daysUntilDue)} day${filing.daysUntilDue === -1 ? "" : "s"} late`
                              : filing.daysUntilDue === 0
                                ? "Today"
                                : `in ${filing.daysUntilDue} day${filing.daysUntilDue === 1 ? "" : "s"}`}
                        {filing.dueOnOverridden ? " · moved by hand" : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* A back-filled period reads as "Before you started",
                          not as a red Overdue. Seeding the calendar mid-year
                          generates the months before it existed, and almost
                          all of those returns were filed on time through
                          somebody's CA - this system simply has no record.
                          The money-leak inbox already refuses to assert it;
                          saying something different here would make the two
                          surfaces disagree, and the louder one would be the
                          one that is wrong. */}
                      {filing.backFilled && filing.status === "overdue" ? (
                        <StatusChip tone="muted">Before you started</StatusChip>
                      ) : (
                        <StatusChip tone={statusTone(filing.status)}>
                          {COMPLIANCE_STATUS_LABELS[filing.status]}
                        </StatusChip>
                      )}
                      {filing.status === "filed" && filing.filedOn ? (
                        <div className="text-xs text-text-muted">
                          {formatDateKey(filing.filedOn)}
                        </div>
                      ) : null}
                      {filing.status === "waived" && filing.waivedReason ? (
                        <div className="text-xs text-text-muted">{filing.waivedReason}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-text-muted">
                      {filing.assignee?.name ?? "—"}
                    </TableCell>
                    <TableCell>
                      {filing.document ? (
                        <Link
                          href="/owner/finance/documents"
                          className="text-xs underline hover:text-text"
                        >
                          {filing.document.title ?? "Attached"}
                        </Link>
                      ) : (
                        <span className="text-xs text-text-muted">
                          {filing.status === "filed" ? "No challan attached" : "—"}
                        </span>
                      )}
                      {item?.verifyWithCa ? (
                        <div className="text-xs text-text-muted">Confirm date with CA</div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* The rules behind the calendar, so somebody can see WHY a date is what
          it is without opening a settings screen. A rule a person has broken by
          hand is named rather than hidden - the API returns dueRuleValid false
          for it, and a filing cannot be generated from a rule nothing can
          parse. */}
      {itemList.some((i) => !i.dueRuleValid) ? (
        <Card>
          <p className="text-sm text-text-muted">
            <strong className="text-text">Some due-date rules cannot be read.</strong> These items
            will not generate new filings until their rule is fixed:{" "}
            {itemList
              .filter((i) => !i.dueRuleValid)
              .map((i) => i.name)
              .join(", ")}
            .
          </p>
        </Card>
      ) : null}
    </>
  );
}
