import type { Metadata } from "next";
import Link from "next/link";
import { formatDateKey } from "@aura/shared";
import { Card, EmptyState, StatusChip } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature } from "@/lib/owner-context";

export const metadata: Metadata = { title: "Month-end close" };

interface CloseStep {
  key: string;
  label: string;
  blurb: string;
  blocksLock: boolean;
  href: string | null;
  done: boolean;
  doneAt: string | null;
  doneBy: string | null;
  note: string | null;
}

interface CloseData {
  month: string;
  label: string;
  today: string;
  locked: { at: string; by: string | null; note: string | null } | null;
  readiness: { done: number; total: number; blocking: string[]; outstanding: string[]; complete: boolean };
  steps: CloseStep[];
  outstanding: { unmatchedPayments: number; pendingExpenses: number };
}

/**
 * §2's month-end close checklist, with the period lock beside it.
 *
 * ── THE CHECKLIST WARNS; IT DOES NOT BLOCK ──────────────────────────────────
 *
 * Three steps are marked as blocking - payments matched, bank reconciled,
 * expenses approved - and the lock still works with them outstanding. That is
 * deliberate, and `CloseStepSpec.blocksLock` carries the reasoning: an owner
 * closing a month with one reconciliation open has a reason, and a system that
 * refuses leaves them unable to close the books at all. They would lock
 * nothing, and an unlocked month is worse than a month closed with a known
 * gap. So the page shows what is outstanding and lets them decide.
 *
 * ── AND IT NEVER SHOWS THE MONTH IN PROGRESS ────────────────────────────────
 *
 * The default is LAST month. A month cannot be closed while it is still
 * running, and offering it invites somebody to lock the current month and then
 * find they cannot record today's payment - 0172's period trigger would refuse
 * it with a check violation.
 */
export default async function ClosePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFeature("/owner/finance/close");

  const sp = await searchParams;
  const raw = Array.isArray(sp.month) ? sp.month[0] : sp.month;
  const month = typeof raw === "string" && /^\d{4}-\d{2}/.test(raw) ? raw : undefined;

  const close = await ownerTry<CloseData>(
    `/v1/finance/compliance/close${month ? `?month=${month}-01` : ""}`,
  );

  if (!close.ok) {
    return (
      <>
        <PageHeader title="Month-end close" context="Sales" />
        <LoadFailure what="the close checklist" failure={close} />
      </>
    );
  }

  const data = close.data;
  const { readiness } = data;
  const blocking = new Set(readiness.blocking);

  return (
    <>
      <PageHeader
        title="Month-end close"
        context="Sales"
        description={`Closing ${data.label}.`}
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

      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div className="text-2xl font-semibold tabular-nums text-text">
              {readiness.done} of {readiness.total}
            </div>
            <p className="text-xs text-text-muted">steps done</p>
          </div>
          <div>
            {data.locked ? (
              <StatusChip tone="outline">Locked {formatDateKey(data.locked.at.slice(0, 10))}</StatusChip>
            ) : readiness.complete ? (
              <StatusChip tone="solid">Ready to lock</StatusChip>
            ) : (
              <StatusChip tone="muted">Open</StatusChip>
            )}
          </div>
        </div>

        {data.locked ? (
          <p className="mt-3 text-sm text-text-muted">
            {data.label} is locked{data.locked.by ? ` by ${data.locked.by}` : ""}. Nothing can be
            dated into it until it is reopened.
          </p>
        ) : readiness.blocking.length > 0 ? (
          <p className="mt-3 text-sm text-text-muted">
            <strong className="text-text">
              {readiness.blocking.length} step
              {readiness.blocking.length === 1 ? "" : "s"} outstanding that affect the numbers.
            </strong>{" "}
            You can still lock the month - these are a warning, not a bar - but the figures for{" "}
            {data.label} will not be final.
          </p>
        ) : null}
      </Card>

      {/* The two counts that say whether the blocking steps are even
          achievable yet. Read from the API's own aggregate rather than
          inferred from the checklist, because a ticked box is a claim and
          these are facts. */}
      {data.outstanding.unmatchedPayments > 0 || data.outstanding.pendingExpenses > 0 ? (
        <Card>
          <h2 className="text-sm font-medium text-text">Still outstanding in {data.label}</h2>
          <ul className="mt-2 space-y-1 text-sm text-text-muted">
            {data.outstanding.unmatchedPayments > 0 ? (
              <li>
                <Link href="/owner/finance/payments" className="underline hover:text-text">
                  {data.outstanding.unmatchedPayments} payment
                  {data.outstanding.unmatchedPayments === 1 ? "" : "s"} not matched to a deal
                </Link>
              </li>
            ) : null}
            {data.outstanding.pendingExpenses > 0 ? (
              <li>
                <Link href="/owner/finance/expenses" className="underline hover:text-text">
                  {data.outstanding.pendingExpenses} expense
                  {data.outstanding.pendingExpenses === 1 ? "" : "s"} waiting for approval
                </Link>
              </li>
            ) : null}
          </ul>
          <p className="mt-2 text-xs text-text-muted">
            An unapproved expense is not in any cost figure yet, so the margin for {data.label} will
            move when these are approved.
          </p>
        </Card>
      ) : null}

      {data.steps.length === 0 ? (
        <EmptyState title="No checklist" description="The close checklist could not be loaded." />
      ) : (
        <Card>
          <ol className="divide-y divide-border">
            {data.steps.map((step, index) => (
              <li key={step.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span
                  aria-hidden
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums ${
                    step.done ? "border-accent text-text" : "border-border text-text-muted"
                  }`}
                >
                  {step.done ? "✓" : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    {step.href ? (
                      <Link href={step.href} className="text-sm font-medium text-text underline hover:text-accent">
                        {step.label}
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-text">{step.label}</span>
                    )}
                    {!step.done && blocking.has(step.key) ? (
                      <StatusChip tone="solid">Affects the numbers</StatusChip>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">{step.blurb}</p>
                  {step.done ? (
                    <p className="mt-0.5 text-xs text-text-subtle">
                      Done{step.doneBy ? ` by ${step.doneBy}` : ""}
                      {step.doneAt ? ` on ${formatDateKey(step.doneAt.slice(0, 10))}` : ""}
                      {step.note ? ` — ${step.note}` : ""}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card>
        <p className="text-sm text-text-muted">
          Locking a month stops anything being dated into it - a payment, an expense or a ledger
          entry. It is enforced by the database, not by this screen, so a background job cannot
          write into a closed month either. Reopening is a separate decision with its own record.
        </p>
      </Card>
    </>
  );
}
