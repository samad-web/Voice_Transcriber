"use client";

import { useState, useTransition } from "react";
import { Button, Card, Checkbox, ErrorBanner, FormField, PasswordInput, useToast } from "@aura/ui";
import { PASSWORD_POLICY_HINT, PASSWORD_PROBLEM_TEXT, type PasswordProblem } from "@aura/shared";
import { changePasswordAction } from "@/app/login/password-actions";

/**
 * Profile -> Password (doc 27 §4.1), the same card in both consoles.
 *
 * The current password is required, and "Sign out of my other devices" is ON
 * by default: the commonest reason to change a password is suspecting someone
 * else has it, and a change that leaves their session running would not help.
 *
 * Nothing here is sent by email - there is no "forgot password" link, because
 * this platform has no working auth email (SMTP is not configured).
 */
export function PasswordCard({ enabled = true }: { enabled?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [problems, setProblems] = useState<PasswordProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const nextProblems = problems.filter((p) => p !== "mismatch");
  const confirmProblem = problems.includes("mismatch") ? PASSWORD_PROBLEM_TEXT.mismatch : undefined;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setWarning(null);
    setProblems([]);
    startTransition(async () => {
      const result = await changePasswordAction({ current, next, confirm, signOutOthers });
      if (result.problems?.length) {
        setProblems(result.problems);
        return;
      }
      if (result.error) {
        setError(result.error);
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      if (result.othersError) {
        // The password DID change; only the second half failed. Said apart.
        setWarning(result.othersError);
        toast("Password changed.");
      } else {
        toast(result.othersSignedOut ? "Password changed. Your other devices were signed out." : "Password changed.");
      }
    });
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-text">Password</h2>
          <p className="mt-1 text-sm text-text-muted">
            {enabled
              ? "Change the password you sign in with. You'll need your current one."
              : "Sign-in is not configured on this console, so there is no password to change."}
          </p>
        </div>

        {enabled ? (
          <>
            <FormField label="Current password" name="current-password" className="max-w-sm">
              <PasswordInput
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </FormField>
            <FormField
              label="New password"
              name="new-password"
              className="max-w-sm"
              hint={PASSWORD_POLICY_HINT}
              error={nextProblems.length ? nextProblems.map((p) => PASSWORD_PROBLEM_TEXT[p]).join(" ") : undefined}
            >
              <PasswordInput
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </FormField>
            <FormField label="Confirm new password" name="confirm-password" className="max-w-sm" error={confirmProblem}>
              <PasswordInput
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </FormField>
            <Checkbox
              checked={signOutOthers}
              onChange={(e) => setSignOutOthers(e.target.checked)}
              label="Sign out of my other devices"
              description="Every other browser signed in as you will need the new password. Handsets are not affected."
            />

            {error ? <ErrorBanner>{error}</ErrorBanner> : null}
            {warning ? <ErrorBanner>{warning}</ErrorBanner> : null}

            <Button type="submit" loading={pending} disabled={!current || !next || !confirm}>
              Change password
            </Button>
          </>
        ) : null}
      </form>
    </Card>
  );
}
