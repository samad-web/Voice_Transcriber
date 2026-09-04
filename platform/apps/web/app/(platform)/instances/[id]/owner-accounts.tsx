"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Copy, Trash2, UserPlus } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip, useAlert, useToast } from "@aura/ui";
import { inputClass } from "@/lib/form";
import {
  createOwnerAction,
  resetOwnerPasswordAction,
  revokeOwnerAction,
  type OwnerResult,
} from "./actions";

export interface OwnerRow {
  userId: string;
  email: string;
  name: string | null;
  status: string;
  hasLogin: boolean;
  recordingsListen: boolean;
  recordingsExport: boolean;
  createdAt: string;
}

/**
 * Owner logins for this customer.
 *
 * An owner signs in to /owner and sees only this instance: their own pipeline,
 * their own telecallers. They never reach the operator console - that is the
 * point of provisioning them here rather than handing over a shared login.
 */
export function OwnerAccounts({
  orgId,
  owners,
  authConfigured,
}: {
  orgId: string;
  owners: OwnerRow[];
  authConfigured: boolean;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [canListen, setCanListen] = useState(true);
  const [result, setResult] = useState<(OwnerResult & { forEmail?: string }) | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const create = () =>
    startTransition(async () => {
      const created = await createOwnerAction({
        orgId,
        email,
        name,
        recordingsListen: canListen,
      });
      if (created.error) {
        await alert({
          title: "Couldn't create the owner login",
          body: created.error,
          tone: "danger",
        });
        return;
      }
      setResult({ ...created, forEmail: email.trim() });
      setEmail("");
      setName("");
    });

  const reset = (userId: string, forEmail: string) =>
    startTransition(async () => {
      const outcome = await resetOwnerPasswordAction(orgId, userId);
      if (outcome.error) {
        await alert({
          title: "Couldn't reset the password",
          body: outcome.error,
          tone: "danger",
        });
        return;
      }
      setResult({ ...outcome, forEmail });
    });

  const revoke = (userId: string) =>
    startTransition(async () => {
      const outcome = await revokeOwnerAction(orgId, userId);
      if (outcome.error) {
        await alert({
          title: "Couldn't revoke the owner",
          body: outcome.error,
          tone: "danger",
        });
        return;
      }
      setConfirming(null);
      setResult(null);
      toast("Owner revoked");
    });

  return (
    <Card elevated className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <MonoLabel>Owner Logins</MonoLabel>
          <p className="text-xs text-neutral-500 font-sans mt-1.5 leading-relaxed max-w-md">
            A sign-in scoped to this instance only. Owners land on their own
            dashboard, lead board and lead list - never the operator console.
          </p>
        </div>
        <StatusChip tone={owners.length > 0 ? "solid" : "muted"}>
          {owners.length} owner{owners.length === 1 ? "" : "s"}
        </StatusChip>
      </div>

      {!authConfigured ? (
        <div className="flex items-start gap-2.5 rounded-md border border-warning bg-warning-subtle p-3">
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 mt-0.5 text-warning" />
          <p className="text-sm leading-relaxed text-warning-text">
            Supabase Auth is not configured on the API - set SUPABASE_URL and
            SUPABASE_SERVICE_ROLE_KEY, then restart it. Logins cannot be created
            until then.
          </p>
        </div>
      ) : null}

      {owners.length > 0 ? (
        <div className="divide-y-2 divide-neutral-100 border-2 border-neutral-200">
          {owners.map((owner) => (
            <div
              key={owner.userId}
              className="px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap"
            >
              <div className="min-w-0">
                <span className="font-display font-bold text-black block truncate">
                  {owner.name || owner.email}
                </span>
                <span className="text-[10px] font-mono text-neutral-400 break-all">
                  {owner.name ? `${owner.email} · ` : ""}
                  added {new Date(owner.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {owner.hasLogin ? null : <StatusChip tone="muted">no login</StatusChip>}
                {owner.recordingsListen ? <StatusChip tone="outline">audio</StatusChip> : null}
                <button
                  type="button"
                  disabled={pending || !owner.hasLogin}
                  onClick={() => reset(owner.userId, owner.email)}
                  className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-1 border-2 border-black hover:bg-black hover:text-white disabled:opacity-30 disabled:hover:bg-white disabled:hover:text-black"
                >
                  Reset password
                </button>
                {confirming === owner.userId ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => revoke(owner.userId)}
                    className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-1 border-2 border-black bg-red-500 text-white"
                  >
                    Confirm revoke
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setConfirming(owner.userId)}
                    aria-label={`Revoke ${owner.email}`}
                    className="p-1.5 border-2 border-black text-black hover:bg-red-500 hover:text-white hover:border-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-6 text-center border-2 border-neutral-200">
          No owner has access yet
        </p>
      )}

      <div className="space-y-3 pt-2 border-t-2 border-neutral-200">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Owner Email
            </label>
            <input
              className={inputClass}
              type="email"
              placeholder="owner@customer.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Name <span className="text-neutral-400">(optional)</span>
            </label>
            <input
              className={inputClass}
              placeholder="Ravi Kumar"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs font-sans text-neutral-600">
          <input
            type="checkbox"
            checked={canListen}
            onChange={(e) => setCanListen(e.target.checked)}
            className="w-4 h-4 border-2 border-black accent-black"
          />
          May listen to call recordings
        </label>

        <BrutalButton
          className="w-full"
          shadow
          disabled={pending || !email.trim() || !authConfigured}
          onClick={create}
        >
          <UserPlus className="h-4 w-4" />
          {pending ? "WORKING…" : "CREATE OWNER LOGIN"}
        </BrutalButton>
      </div>

      {result?.password ? (
        <PasswordReveal email={result.forEmail ?? result.email ?? ""} password={result.password} />
      ) : null}

      {result?.linkedExisting ? (
        <p className="text-xs font-mono font-bold uppercase text-neutral-500 border-2 border-black p-3">
          {result.forEmail} already had an Aura login - it was linked to this
          instance and keeps its existing password.
        </p>
      ) : null}
    </Card>
  );
}

/** Same one-time contract as the enrollment key: copy it now or reset it later. */
function PasswordReveal({ email, password }: { email: string; password: string }) {
  const alert = useAlert();
  const toast = useToast();

  return (
    <div className="border-2 border-black bg-white p-3.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>Temporary password - shown once</MonoLabel>
        <StatusChip tone="danger">Copy now</StatusChip>
      </div>
      <p className="text-xs font-sans text-neutral-600 break-all">{email}</p>
      <div className="bg-black text-green-400 border-2 border-black p-2.5 font-mono text-sm break-all">
        {password}
      </div>
      <BrutalButton
        variant="secondary"
        className="w-full"
        // Sync, not `async` - see api-keys-manager.tsx: React discards an event
        // handler's return value, so an async onClick turns a rejected
        // clipboard write (insecure origin, denied permission) into an
        // unhandled rejection. This password is shown once and never
        // recovered, so a failed copy must SAY so rather than pass silently.
        onClick={() => {
          void navigator.clipboard
            .writeText(password)
            .then(() => toast("Copied"))
            .catch(() =>
              alert({
                title: "Couldn't copy the password",
                body: "Select it above and copy it by hand - it is not shown again.",
                tone: "danger",
              }),
            );
        }}
      >
        <Copy className="h-4 w-4" />
        COPY PASSWORD
      </BrutalButton>
      <p className="text-[10px] font-mono text-neutral-500 leading-relaxed">
        Send it over a channel the customer trusts and have them change it after
        the first sign-in. A lost password is reset here, never recovered.
      </p>
    </div>
  );
}
