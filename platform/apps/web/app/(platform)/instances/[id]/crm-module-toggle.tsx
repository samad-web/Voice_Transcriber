"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Handshake } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip, useConfirm } from "@aura/ui";
import { setCrmEnabledAction } from "./actions";
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
}: {
  orgId: string;
  enabled: boolean;
  instanceName: string;
  /** Owner accounts for this instance - the people who can actually sign in. */
  owners: OwnerRow[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();

  const toggle = async (next: boolean) => {
    if (!next) {
      const ok = await confirm({
        title: `Turn off CRM for ${instanceName}?`,
        body:
          "Contacts, Accounts, Deals and everything else in the CRM stay stored - the client's " +
          "team just loses access to them until you switch this back on.",
        confirmLabel: "Turn off CRM",
        tone: "danger",
      });
      if (!ok) return;
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

      {enabled ? <SignInDetails instanceName={instanceName} owners={owners} /> : null}

      <BrutalButton
        variant={enabled ? "secondary" : "primary"}
        disabled={pending}
        onClick={() => void toggle(!enabled)}
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

/**
 * Where this client signs in, shown the moment CRM is switched on.
 *
 * Enabling the module is only half of handing a CRM over - the operator still
 * has to tell somebody where to go and confirm a login exists. That answer used
 * to live only in this repo's docs, so it was retold by hand every time.
 *
 * The URL is built from `window.location.origin` on mount rather than from an
 * env var: the console already knows its own origin, and `NEXT_PUBLIC_BASE_PATH`
 * (baked in at image build) is the same prefix Next puts on every link here. A
 * separate "console URL" setting would be a third place for the same fact to
 * drift out of date. It is deferred to an effect because the server render has
 * no `window` and a guess would mismatch on hydration.
 */
function SignInDetails({ instanceName, owners }: { instanceName: string; owners: OwnerRow[] }) {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    setUrl(`${window.location.origin}${basePath}/login`);
  }, []);

  // `hasLogin` is the Supabase account; `status` is whether we still honour it.
  // A member with one and not the other cannot sign in, so neither alone counts.
  const canSignIn = owners.filter((o) => o.hasLogin && o.status === "active");

  return (
    <div className="border-2 border-black bg-white p-3.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <MonoLabel>Where {instanceName} signs in</MonoLabel>
        <StatusChip tone={canSignIn.length > 0 ? "solid" : "danger"}>
          {canSignIn.length > 0 ? `${canSignIn.length} can sign in` : "No logins yet"}
        </StatusChip>
      </div>

      <div className="bg-neutral-50 border-2 border-black p-2.5 font-mono text-xs break-all">
        {url ?? "Loading…"}
      </div>

      <BrutalButton
        variant="secondary"
        className="w-full"
        disabled={!url}
        // Sync, not `async` - same reasoning as PasswordReveal in
        // owner-accounts.tsx: React discards the return value, so an async
        // handler turns a rejected clipboard write into an unhandled rejection.
        onClick={() => {
          if (!url) return;
          void navigator.clipboard
            .writeText(url)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? "COPIED" : "COPY SIGN-IN LINK"}
      </BrutalButton>

      {canSignIn.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] font-mono uppercase tracking-wide text-neutral-500">
            Accounts that can sign in
          </p>
          <ul className="space-y-0.5">
            {canSignIn.map((o) => (
              <li key={o.userId} className="font-mono text-[11px] text-neutral-700 break-all">
                {o.email}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-red-700 font-sans font-medium border-2 border-red-600 bg-red-50 p-2.5 leading-relaxed">
          Nobody can sign in yet. Create one in <strong>Owner accounts</strong> above - that makes
          the login and grants access to this instance in a single step, and shows a temporary
          password once.
        </p>
      )}

      <p className="text-[10px] font-mono text-neutral-500 leading-relaxed">
        They sign in with their email and password and land straight on this instance. The
        instance is resolved from the sign-in itself, so there is nothing for them to pick and no
        address that reaches another client&rsquo;s data.
      </p>
    </div>
  );
}
