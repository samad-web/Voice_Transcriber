"use client";

import { useId, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Handshake } from "lucide-react";
import { Button, MonoLabel, RowHint, StatusChip, useAlert, useConfirm } from "@aura/ui";
import { SignInLink } from "../sign-in-link";
import { setModuleEnabledAction } from "./actions";
import { MODULE_INSET, ModuleCard } from "./module-card";
import type { OwnerRow } from "./owner-accounts";

/**
 * CRM on/off for one tenant (migration 0072, `organizations.enabled_modules`).
 *
 * Off by default at creation - see instances/new/instance-form.tsx. Turning
 * it on here seeds the 5 system roles + a default deal pipeline the first
 * time (idempotent: re-enabling after a disable does not reseed). Turning it
 * off does not delete anything already seeded - it revokes access via
 * CrmPermissionsGuard's module check - so flipping it back on later picks
 * up exactly where the tenant left off.
 */
export function CrmModuleToggle({
  orgId,
  enabled,
  instanceName,
  owners,
  modules,
}: {
  orgId: string;
  enabled: boolean;
  instanceName: string;
  /** Owner accounts for this instance - the people who can actually sign in. */
  owners: OwnerRow[];
  /** The tenant's whole entitlement, so toggling CRM leaves the rest alone. */
  modules: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const hintId = useId();
  const confirm = useConfirm();
  const alert = useAlert();

  const toggle = async (next: boolean) => {
    if (!next) {
      const ok = await confirm({
        title: `Turn off CRM for ${instanceName}?`,
        body:
          "Contacts, Accounts, Deals and everything else in the CRM stay stored - the client's " +
          "team just loses access to them until you switch this back on.",
        confirmLabel: "Turn off CRM",
        tone: "danger",
        // Nothing is deleted - the body above says so explicitly - and the
        // switch goes back on. No gate.
        requireTyped: false,
      });
      if (!ok) return;
    }
    startTransition(async () => {
      const res = await setModuleEnabledAction({
        orgId,
        module: "crm",
        enabled: next,
        current: modules,
      });
      if (res.error) {
        await alert({
          title: next ? "Couldn't turn on the CRM" : "Couldn't turn off the CRM",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      router.refresh();
    });
  };

  return (
    <ModuleCard
      icon={<Handshake className="h-4 w-4" />}
      title="CRM"
      enabled={enabled}
      action={
        <Button
          type="button"
          variant={enabled ? "secondary" : "primary"}
          size="sm"
          disabled={pending}
          loading={pending}
          aria-describedby={`${hintId}-state`}
          onClick={() => void toggle(!enabled)}
        >
          {enabled ? "Turn off CRM" : "Turn on CRM"}
        </Button>
      }
    >
      <RowHint kind="toggle" id={`${hintId}-state`}>
        {enabled
          ? "On: this client's team has Contacts, Accounts, Deals, Tasks and the rest of the CRM."
          : "Off: not part of this client's plan yet. Calls are still recorded and transcribed as usual, and any CRM records already stored stay stored."}
      </RowHint>

      {enabled ? <SignInDetails instanceName={instanceName} owners={owners} /> : null}
    </ModuleCard>
  );
}

/**
 * Where this client signs in, shown the moment CRM is switched on.
 *
 * Enabling the module is only half of handing a CRM over - the operator still
 * has to tell somebody where to go and confirm a login exists. That answer used
 * to live only in this repo's docs, so it was retold by hand every time.
 *
 * The link itself comes from `../sign-in-link`, which the Instances list also
 * renders: the address is the console's, not this tenant's, so there must not
 * be two places deciding how it is built. What is local to here is the second
 * half of the answer - WHO can actually use it for this instance.
 */
function SignInDetails({ instanceName, owners }: { instanceName: string; owners: OwnerRow[] }) {
  // `hasLogin` is the Supabase account; `status` is whether we still honour it.
  // A member with one and not the other cannot sign in, so neither alone counts.
  const canSignIn = owners.filter((o) => o.hasLogin && o.status === "active");

  return (
    <div className={`space-y-3 ${MODULE_INSET}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-text">Where {instanceName} signs in</p>
        <StatusChip tone={canSignIn.length > 0 ? "solid" : "danger"}>
          {canSignIn.length > 0 ? `${canSignIn.length} can sign in` : "No logins yet"}
        </StatusChip>
      </div>

      <SignInLink />

      {canSignIn.length > 0 ? (
        <div className="space-y-1.5">
          <MonoLabel>Accounts that can sign in</MonoLabel>
          {/* Wrapping pills rather than one address per line: two or three
              logins sit on a single row, so this panel does not stretch the
              card next to it by a line per account. */}
          <ul className="flex flex-wrap gap-1.5">
            {canSignIn.map((o) => (
              <li
                key={o.userId}
                className="rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-xs break-all text-text"
              >
                {o.email}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        // Was a red-bordered, red-filled panel. Red means MISSED now, and this
        // is neither a missed call nor - strictly - an error: it is a setup step
        // nobody has done yet. Neutral chrome plus a hint that says what to do
        // carries it, and leaves the palette for the four things that need it.
        <div className="rounded-md border border-border bg-surface p-2.5">
          <RowHint kind="action">
            Nobody can sign in yet. Create an account in the <strong>Access</strong> section below -
            that makes the login and grants access to this instance in a single step, and shows a
            temporary password once.
          </RowHint>
        </div>
      )}

      <p className="text-xs leading-relaxed text-text-muted">
        They sign in with their email and password and land straight on this instance. It is
        resolved from the sign-in itself, so there is nothing to pick and no address that reaches
        another client&rsquo;s data.
      </p>
    </div>
  );
}
