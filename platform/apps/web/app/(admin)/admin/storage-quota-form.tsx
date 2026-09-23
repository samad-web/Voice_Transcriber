"use client";

import { useState, useTransition } from "react";
import { Button, Input } from "@aura/ui";
import { setStorageQuotaAction } from "./actions";

/**
 * The quota cell on /admin's tenants table (doc 27 §6.4). GB in, bytes stored
 * - converted server-side with the meter's own 1024 factor. Empty clears it.
 * A quota never blocks an upload; it draws a meter and sends the owners an
 * in-app note at 80 % and 100 %.
 */
export function StorageQuotaForm({ orgId, quotaGb }: { orgId: string; quotaGb: number | null }) {
  const [value, setValue] = useState(quotaGb === null ? "" : String(quotaGb));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = value.trim() !== (quotaGb === null ? "" : String(quotaGb));

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmed = value.trim();
    const gb = trimmed === "" ? null : Number(trimmed);
    startTransition(async () => {
      const result = await setStorageQuotaAction(orgId, gb);
      if (result.error) setError(result.error);
    });
  };

  return (
    <form onSubmit={save} className="flex items-center gap-1.5">
      <Input
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="None"
        aria-label="Storage quota in GB"
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        className="w-20 font-mono text-xs"
      />
      <span className="text-xs text-text-muted">GB</span>
      {dirty ? (
        <Button type="submit" size="sm" variant="secondary" loading={pending}>
          Save
        </Button>
      ) : null}
      {/* Orange: it is an error state (state.tsx), not a missed call. */}
      {error ? (
        <span role="alert" className="max-w-[12rem] text-xs text-danger-text">
          {error}
        </span>
      ) : null}
    </form>
  );
}
