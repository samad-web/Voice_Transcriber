"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Handshake } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { setCrmEnabledAction } from "./actions";

/**
 * CRM on/off for one tenant (migration 0072, `organizations.enabled_modules`).
 *
 * Off by default at creation — see instances/new/instance-form.tsx. Turning
 * it on here seeds the 5 system roles + a default deal pipeline the first
 * time (idempotent: re-enabling after a disable does not reseed). Turning it
 * off does not delete anything already seeded — it revokes access via
 * CrmPermissionsGuard's module check — so flipping it back on later picks
 * up exactly where the tenant left off.
 */
export function CrmModuleToggle({
  orgId,
  enabled,
  instanceName,
}: {
  orgId: string;
  enabled: boolean;
  instanceName: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (next: boolean) => {
    if (
      !next &&
      !window.confirm(
        `Turn off CRM for ${instanceName}?\n\n` +
          "Contacts, Accounts, Deals and everything else in the CRM stay stored — " +
          "the client's team just loses access to them until you switch this back on.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await setCrmEnabledAction({ orgId, enabled: next });
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <Card elevated className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Handshake className="h-4 w-4" />
          <MonoLabel>CRM</MonoLabel>
        </div>
        <StatusChip tone={enabled ? "solid" : "muted"}>{enabled ? "On" : "Off"}</StatusChip>
      </div>

      <p className="text-xs text-neutral-500 font-sans font-medium leading-relaxed">
        {enabled
          ? "This client's team has Contacts, Accounts, Deals, Tasks and the rest of the CRM."
          : "Not part of this client's plan yet. Calls are still recorded and transcribed as usual."}
      </p>

      <BrutalButton
        variant={enabled ? "secondary" : "primary"}
        disabled={pending}
        onClick={() => toggle(!enabled)}
      >
        {pending ? "SAVING…" : enabled ? "DISABLE CRM" : "ENABLE CRM"}
      </BrutalButton>

      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
