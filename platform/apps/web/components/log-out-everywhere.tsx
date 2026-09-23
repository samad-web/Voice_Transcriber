"use client";

import { useState, useTransition } from "react";
import { LogOut } from "lucide-react";
import { Button, Dialog, ErrorBanner } from "@aura/ui";
import { signOutEverywhereAction } from "@/app/login/actions";

/**
 * "Log out from all devices" - the confirm, and the button that opens it
 * (doc 27 §3.2).
 *
 * The kit Dialog rather than `confirm()`: when the revoke fails the dialog has
 * to STAY OPEN and say so in orange, and a promise-shaped confirm has already
 * closed by the time the answer is known. It is not a data deletion, so there
 * is no type-DELETE gate and the confirming button is the ordinary primary one,
 * not a red one - the palette keeps red for missed calls.
 *
 * The text says handsets are unaffected on purpose: "all devices" is read as
 * "the phones too", and a manager who thinks they just stopped the floor
 * recording has been told something false.
 */
export function LogOutEverywhereDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (pending) return;
    setError(null);
    onClose();
  };

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      // On success the action redirects to /login and this never returns.
      const result = await signOutEverywhereAction();
      if (result?.error) setError(result.error);
    });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Log out from all devices?"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={confirm} loading={pending}>
            {pending ? "Logging out…" : "Log out everywhere"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-text-muted">
          You&apos;ll be signed out of Aura in every browser, including this one, and will need your password to sign
          in again. Handsets are not affected and keep recording. To stop a handset, remove it from Devices.
        </p>
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      </div>
    </Dialog>
  );
}

/** The same confirm, as a page-header action (Login activity). */
export function LogOutEverywhereButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Log out from all devices
      </Button>
      <LogOutEverywhereDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
