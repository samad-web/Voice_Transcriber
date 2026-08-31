"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Unlock } from "lucide-react";
import { Button, Card, FormField, Input, MonoLabel, StatusChip, useConfirm } from "@aura/ui";
import { setAppLockPasswordAction } from "./actions";

/**
 * The mobile app-lock password for one instance. Every handset enrolled
 * under this org shows a lock screen on open, checked offline against the
 * hash synced through devices/me/config - set it here, never read back.
 */
export function AppLockForm({ orgId, enabled }: { orgId: string; enabled: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();

  const save = () => {
    if (password.trim().length < 4) {
      setError("Password must be at least 4 characters.");
      return;
    }
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await setAppLockPasswordAction({ orgId, password: password.trim() });
      if (res.error) {
        setError(res.error);
        return;
      }
      setPassword("");
      setEditing(false);
      setNote(enabled ? "Password changed." : "App lock turned on.");
      router.refresh();
    });
  };

  const clear = async () => {
    const ok = await confirm({
      title: "Turn off the app lock?",
      body: "Every enrolled handset will open straight to the recordings list again, with no password.",
      confirmLabel: "Turn off lock",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await setAppLockPasswordAction({ orgId, password: null });
      if (res.error) {
        setError(res.error);
        return;
      }
      setNote("App lock turned off.");
      router.refresh();
    });
  };

  return (
    <Card elevated className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {enabled ? (
            <Lock className="h-4 w-4 text-text-muted" />
          ) : (
            <Unlock className="h-4 w-4 text-text-muted" />
          )}
          <MonoLabel>App lock</MonoLabel>
        </div>
        <StatusChip tone={enabled ? "solid" : "muted"}>{enabled ? "On" : "Off"}</StatusChip>
      </div>

      <p className="text-sm text-text-muted leading-relaxed">
        {enabled
          ? "Every handset enrolled under this instance asks for this password when the app is opened. Synced automatically - no re-enrollment needed."
          : "Off by default: the app opens straight to the recordings list. Set a password here to require it on every enrolled handset."}
      </p>

      {editing ? (
        <div className="space-y-3 rounded-md border border-border bg-bg-subtle p-4">
          <FormField label={enabled ? "New password" : "Set password"} name="app-lock-password">
            <Input
              type="password"
              autoFocus
              minLength={4}
              maxLength={72}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 4 characters"
            />
          </FormField>
          <div className="flex items-center gap-2">
            <Button type="button" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setPassword("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <Button type="button" disabled={pending} onClick={() => setEditing(true)}>
            <Lock className="h-4 w-4" />
            {enabled ? "Change password" : "Set password"}
          </Button>
          {enabled ? (
            <Button type="button" variant="secondary" disabled={pending} onClick={clear}>
              <Unlock className="h-4 w-4" />
              Turn off
            </Button>
          ) : null}
        </div>
      )}

      {note ? (
        <p role="status" className="rounded-md border border-border bg-bg-subtle p-3 text-sm text-text">
          {note}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text"
        >
          {error}
        </p>
      ) : null}
    </Card>
  );
}
