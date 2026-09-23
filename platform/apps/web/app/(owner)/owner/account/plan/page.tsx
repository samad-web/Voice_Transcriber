import type { Metadata } from "next";
import { Clock, Languages, Phone, Smartphone, Users } from "lucide-react";
import { Card, ProgressBar, StatCard, StatusChip } from "@aura/ui";
import {
  ORG_MODULES,
  daysUntilQuota,
  formatBytes,
  storagePercent,
  storageUsedBytes,
  type PlanUsage,
} from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { accountPageRoles } from "@/lib/account-menu";
import { ownerTry, requireOwnerRoles } from "@/lib/owner-context";
// "To change your plan, contact your account manager" - linked when the
// deployment names a support contact, plain text otherwise.
import { supportHref } from "@/lib/support-contact";

export const metadata: Metadata = { title: "Plan & usage" };


function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));
}

function monthLabel(start: string): string {
  // `start` is a calendar date (YYYY-MM-DD) in the org's zone - formatted as a
  // date at UTC noon so no zone can push it into the previous month.
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${start}T12:00:00Z`),
  );
}

/**
 * Plan & usage (doc 27 §6.7) - the account menu's third entry.
 *
 * Every card is backed by a real number, and there is deliberately no invoices
 * card: Aura issues tenants no invoices yet, and an empty section that will
 * never fill is a dead end. The entry is labelled "Plan & usage" rather than
 * "Billing" for the same reason.
 */
export default async function PlanUsagePage() {
  await requireOwnerRoles(accountPageRoles("plan"));
  const result = await ownerTry<{ usage: PlanUsage | null }>("/v1/owner/plan-usage");

  if (!result.ok || !result.data.usage) {
    return (
      <>
        <PageHeader title="Plan & usage" context="Account" />
        {!result.ok ? <LoadFailure what="your plan and usage" failure={result} /> : null}
      </>
    );
  }

  const usage = result.data.usage;
  const support = supportHref();
  const modules = ORG_MODULES.filter((m) => usage.modules.includes(m.id));
  const storage = usage.storage;
  const percent = storage ? storagePercent(storage) : null;
  const untilFull = storage && usage.growth ? daysUntilQuota(storage, usage.growth.bytes, usage.growth.days) : null;
  const budget = usage.month.transcriptionBudget;

  return (
    <>
      <PageHeader title="Plan & usage" context="Account" />

      <Card className="space-y-3">
        <h2 className="text-base font-semibold text-text">Your plan</h2>
        <div className="flex flex-wrap gap-2">
          {modules.map((m) => (
            <StatusChip key={m.id} tone="muted">
              {m.label}
            </StatusChip>
          ))}
        </div>
        <p className="text-sm text-text-muted">
          Call recordings are kept for {usage.retentionDays} days, then deleted automatically.
        </p>
        <p className="text-sm text-text-muted">
          To change your plan,{" "}
          {support ? (
            <a href={support} className="font-medium text-text underline underline-offset-2">
              contact your account manager
            </a>
          ) : (
            "contact your account manager"
          )}
          .
        </p>
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-text">Storage</h2>
          {storage ? (
            <p className="text-xs text-text-muted">As of {formatDateTime(storage.computedAt, usage.month.timezone)}</p>
          ) : null}
        </div>
        {storage ? (
          <>
            <p className="text-2xl font-semibold text-text">
              {formatBytes(storageUsedBytes(storage))}
              {storage.quotaBytes ? (
                <span className="text-base font-normal text-text-muted"> of {formatBytes(storage.quotaBytes)}</span>
              ) : (
                <span className="text-base font-normal text-text-muted"> used</span>
              )}
            </p>
            {percent !== null ? (
              // Accent below the quota, the orange danger tone at or over it.
              // Never red, and never a block: uploads are not refused.
              <ProgressBar percent={percent} tone={percent >= 100 ? "danger" : "solid"} />
            ) : null}
            <ul className="space-y-1 text-sm text-text-muted">
              <li>
                Call recordings: {formatBytes(storage.recordingBytes)} across{" "}
                {storage.recordingCount.toLocaleString("en-IN")} recording{storage.recordingCount === 1 ? "" : "s"}
              </li>
              {storage.dbBytesEstimate !== null ? (
                <li>CRM data: about {formatBytes(storage.dbBytesEstimate)} (estimated)</li>
              ) : null}
              {usage.growth && usage.growth.bytes > 0 ? (
                <li>
                  +{formatBytes(usage.growth.bytes)} in the last {usage.growth.days} day
                  {usage.growth.days === 1 ? "" : "s"}
                </li>
              ) : null}
            </ul>
            {untilFull !== null && untilFull > 0 ? (
              <p className="text-sm text-text">
                At this rate you&apos;ll reach your limit in about {untilFull} day{untilFull === 1 ? "" : "s"}.
              </p>
            ) : null}
            {percent !== null && percent >= 100 ? (
              <p className="text-sm text-text">
                You&apos;re at your storage limit. Recordings are still being saved - talk to your account manager
                about raising it.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-text-muted">
            Storage is measured every hour. Check back shortly for your first reading.
          </p>
        )}
      </Card>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-text">This month · {monthLabel(usage.month.start)}</h2>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Calls captured"
            value={usage.month.calls.toLocaleString("en-IN")}
            icon={<Phone className="h-5 w-5" />}
          />
          <StatCard
            label="Recorded minutes"
            value={usage.month.recordedMinutes.toLocaleString("en-IN")}
            icon={<Clock className="h-5 w-5" />}
          />
          <StatCard
            label="Transcription minutes"
            value={usage.month.transcriptionMinutes.toLocaleString("en-IN")}
            context={budget !== null ? `of ${budget.toLocaleString("en-IN")} included this month` : "no monthly limit"}
            icon={<Languages className="h-5 w-5" />}
          />
          <StatCard
            label="Active handsets"
            value={usage.activeHandsets.toLocaleString("en-IN")}
            icon={<Smartphone className="h-5 w-5" />}
          />
          <StatCard
            label="Active team members"
            value={usage.activeMembers.toLocaleString("en-IN")}
            icon={<Users className="h-5 w-5" />}
          />
        </div>
        {budget !== null && budget > 0 ? (
          <Card className="space-y-2">
            <p className="text-sm text-text">
              Transcription: {usage.month.transcriptionMinutes.toLocaleString("en-IN")} of{" "}
              {budget.toLocaleString("en-IN")} minutes
            </p>
            <ProgressBar
              percent={(usage.month.transcriptionMinutes / budget) * 100}
              tone={usage.month.transcriptionMinutes >= budget ? "danger" : "solid"}
            />
            <p className="text-xs text-text-muted">
              Past the limit, new calls are still recorded but not transcribed until next month.
            </p>
          </Card>
        ) : null}
      </section>
    </>
  );
}
