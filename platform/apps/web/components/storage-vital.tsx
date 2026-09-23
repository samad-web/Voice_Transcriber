import { MonoLabel, ProgressBar } from "@aura/ui";
import { formatBytes, storagePercent, storageUsedBytes, type StorageSummary } from "@aura/shared";

/** The storage fields GET /v1/org carries (doc 27 §6.4), as they arrive. */
export interface OrgStorageFields {
  retention_days: number;
  storage_quota_bytes?: string | null;
  storage_usage?: {
    recordingBytes: string | number;
    recordingCount: number;
    dbBytesEstimate: string | number | null;
    computedAt: string;
  } | null;
}

/** GET /v1/org's raw columns as the shared StorageSummary, or null before the first sweep. */
export function storageFromOrg(org: OrgStorageFields): StorageSummary | null {
  const u = org.storage_usage;
  if (!u) return null;
  return {
    recordingBytes: Number(u.recordingBytes),
    recordingCount: u.recordingCount,
    dbBytesEstimate: u.dbBytesEstimate === null ? null : Number(u.dbBytesEstimate),
    quotaBytes: org.storage_quota_bytes ? Number(org.storage_quota_bytes) : null,
    computedAt: u.computedAt,
    retentionDays: org.retention_days,
  };
}

/**
 * The operator's Storage vital (doc 27 §6.4): used, quota and count for one
 * tenant, from the worker's hourly snapshot.
 *
 * `retentionPaused` is §6.5's third finding shown rather than silently fixed:
 * the reaper only sweeps ACTIVE orgs, so a suspended or churned tenant's
 * recordings are never deleted and its storage only grows. Changing that is a
 * retention-policy decision (doc 27 Q6), so until someone makes it the page
 * says so.
 */
export function StorageVital({
  storage,
  retentionPaused = false,
}: {
  storage: StorageSummary | null;
  retentionPaused?: boolean;
}) {
  const percent = storage ? storagePercent(storage) : null;
  return (
    <div className="space-y-2 bg-surface px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>Storage</MonoLabel>
        {storage ? (
          <span className="text-xs text-text-muted tabular-nums">
            {storage.recordingCount.toLocaleString("en-IN")} recording{storage.recordingCount === 1 ? "" : "s"}
            {storage.dbBytesEstimate !== null ? ` · about ${formatBytes(storage.dbBytesEstimate)} of CRM data` : ""}
          </span>
        ) : null}
      </div>
      {storage ? (
        <>
          <p className="text-2xl leading-tight font-semibold text-text tabular-nums">
            {formatBytes(storageUsedBytes(storage))}
            <span className="text-sm font-normal text-text-muted">
              {storage.quotaBytes ? ` of ${formatBytes(storage.quotaBytes)}` : " · no quota set"}
            </span>
          </p>
          {percent !== null ? (
            <ProgressBar percent={percent} tone={percent >= 100 ? "danger" : "solid"} />
          ) : null}
        </>
      ) : (
        <p className="text-sm text-text-muted">Not measured yet - the worker measures every hour.</p>
      )}
      {retentionPaused ? (
        <p className="text-xs text-text-muted">
          Retention paused while suspended: the reaper skips this tenant, so nothing here is deleted.
        </p>
      ) : null}
    </div>
  );
}
