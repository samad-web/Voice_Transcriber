"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Unlock } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { setAppLockPasswordAction } from "./actions";

/**
 * The mobile app-lock password for one instance. Every handset enrolled
 * under this org shows a lock screen on open, checked offline against the
 * hash synced through devices/me/config — set it here, never read back.
 */
export function AppLockForm({ orgId, enabled }: { orgId: string; enabled: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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

  const clear = () => {
    if (
      !window.confirm(
        "Turn off the app lock for this instance?\n\n" +
          "Every enrolled handset will open straight to the recordings list again.",
      )
    ) {
      return;
    }
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
    <Card shadow className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {enabled ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
          <MonoLabel>App lock</MonoLabel>
        </div>
        <StatusChip tone={enabled ? "solid" : "muted"}>{enabled ? "On" : "Off"}</StatusChip>
      </div>

      <p className="text-xs text-neutral-500 font-sans font-medium leading-relaxed">
        {enabled
          ? "Every handset enrolled under this instance asks for this password when the app is opened. Synced automatically — no re-enrollment needed."
          : "Off by default: the app opens straight to the recordings list. Set a password here to require it on every enrolled handset."}
      </p>

      {editing ? (
        <div className="space-y-2 border-2 border-black bg-neutral-50 p-3">
          <MonoLabel>{enabled ? "New password" : "Set password"}</MonoLabel>
          <input
            type="password"
            autoFocus
            minLength={4}
            maxLength={72}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 4 characters"
            className="w-full border-2 border-black bg-white p-2 text-sm font-sans"
          />
          <div className="flex items-center gap-2 pt-1">
            <BrutalButton disabled={pending} onClick={save}>
              {pending ? "SAVING…" : "SAVE"}
            </BrutalButton>
            <BrutalButton
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setPassword("");
                setError(null);
              }}
            >
              CANCEL
            </BrutalButton>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <BrutalButton disabled={pending} onClick={() => setEditing(true)}>
            {enabled ? <Lock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            {enabled ? "CHANGE PASSWORD" : "SET PASSWORD"}
          </BrutalButton>
          {enabled ? (
            <BrutalButton variant="secondary" disabled={pending} onClick={clear}>
              <Unlock className="h-4 w-4" />
              TURN OFF
            </BrutalButton>
          ) : null}
        </div>
      )}

      {note ? (
        <p className="text-xs text-neutral-700 font-sans font-bold border-2 border-black bg-neutral-50 p-3">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
