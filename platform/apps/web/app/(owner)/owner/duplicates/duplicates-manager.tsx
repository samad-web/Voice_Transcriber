"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, EmptyState, MonoLabel, StatusChip } from "@aura/ui";
import {
  dismissDuplicateAction,
  mergeRecordsAction,
  scanDuplicatesAction,
} from "../crm-actions";
import type { DuplicateMatch } from "../types";

/**
 * Review queue for /v1/merge/duplicates — scan, then keep-one-side merge or
 * dismiss each pending pair. No field-by-field picker: the API's
 * fieldDecisions defaults to "keep the survivor's own values", which stays
 * the right default for both match kinds — an external_id collision (both
 * sides already agree on the field that matched) and a fuzzy name match
 * (where the operator picks the side to keep, which IS the decision).
 */
export function DuplicatesManager({ initial }: { initial: DuplicateMatch[] }) {
  const router = useRouter();
  const [duplicates, setDuplicates] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const scan = (objectType: "contact" | "account") => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await scanDuplicatesAction(objectType);
      if (result.error) {
        setError(result.error);
        return;
      }

      // "Found nothing" and "could not look" are different answers, and a
      // queue that stays empty looks identical either way. Say which.
      if (result.fuzzy === "unavailable") {
        setNotice(
          "Scanned exact matches only — fuzzy name matching needs the pg_trgm extension, " +
            "which is not installed on this database.",
        );
      } else if (result.newCandidates === 0) {
        setNotice(`No new duplicates found (name similarity ≥ ${result.threshold ?? ""}).`);
      }

      // The action already revalidates the path; nothing more to do here if
      // the scan found zero — the list simply stays as it was.
      if (result.newCandidates && result.newCandidates > 0) {
        router.refresh();
      }
    });
  };

  const keep = (dup: DuplicateMatch, survivorId: string, victimId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await mergeRecordsAction(dup.object_type, survivorId, victimId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setDuplicates((prev) => prev.filter((d) => d.id !== dup.id));
    });
  };

  const dismiss = (dup: DuplicateMatch) => {
    setError(null);
    startTransition(async () => {
      const result = await dismissDuplicateAction(dup.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setDuplicates((prev) => prev.filter((d) => d.id !== dup.id));
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" loading={pending} onClick={() => scan("contact")}>
          Scan contacts
        </Button>
        <Button type="button" variant="secondary" size="sm" loading={pending} onClick={() => scan("account")}>
          Scan accounts
        </Button>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="rounded-md border border-border bg-surface-hover p-3 text-sm text-text-muted"
        >
          {notice}
        </p>
      ) : null}

      {duplicates.length === 0 ? (
        <EmptyState
          title="No duplicates to review"
          description="Run a scan to look for records that share an external system id, or whose names are close enough to be the same person."
        />
      ) : (
        <div className="space-y-3">
          {duplicates.map((dup) => (
            <Card key={dup.id}>
              <div className="flex items-center justify-between gap-2">
                <MonoLabel>
                  {dup.object_type} · matched on {dup.match_reason.replace(/_/g, " ")}
                </MonoLabel>
                <StatusChip tone="outline">pending</StatusChip>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <RecordSide
                  label={dup.record_a_label}
                  detail={dup.record_a_detail}
                  disabled={pending}
                  onKeep={() => keep(dup, dup.record_a_id, dup.record_b_id)}
                />
                <RecordSide
                  label={dup.record_b_label}
                  detail={dup.record_b_detail}
                  disabled={pending}
                  onKeep={() => keep(dup, dup.record_b_id, dup.record_a_id)}
                />
              </div>

              <div className="mt-3 flex justify-end">
                <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => dismiss(dup)}>
                  Not a duplicate
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordSide({
  label,
  detail,
  disabled,
  onKeep,
}: {
  label: string | null;
  detail: string | null;
  disabled: boolean;
  onKeep: () => void;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="font-medium text-text">{label ?? "Unnamed"}</p>
      <p className="text-xs text-text-muted">{detail ?? "—"}</p>
      <Button type="button" size="sm" className="mt-2" disabled={disabled} onClick={onKeep}>
        Keep this one
      </Button>
    </div>
  );
}
