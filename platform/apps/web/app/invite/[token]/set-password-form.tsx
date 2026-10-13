"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button, ErrorBanner, FormField, PasswordInput } from "@aura/ui";
import { setInvitePasswordAction, type SetPasswordState } from "./set-password-action";

/**
 * The password half of claiming a workspace, for buyers with no Google account.
 *
 * Thin by design: the three-step flow and every reason for it live in
 * `set-password-action.ts`, because all three steps need the server (session
 * cookies, and an API reached with the cross-tenant admin key that must never
 * go near a browser).
 */

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Setting up your workspace…" : "Create my sign-in"}
    </Button>
  );
}

export function SetPasswordForm({ token, email }: { token: string; email: string }) {
  const [state, action] = useActionState<SetPasswordState, FormData>(setInvitePasswordAction, {
    error: null,
  });

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="email" value={email} />
      {state.error ? <ErrorBanner>{state.error}</ErrorBanner> : null}
      <FormField label="Create a password" name="password" required>
        <PasswordInput name="password" autoComplete="new-password" minLength={12} required />
      </FormField>
      <FormField label="Type it again" name="passwordConfirm" required>
        <PasswordInput name="passwordConfirm" autoComplete="new-password" minLength={12} required />
      </FormField>
      <Submit />
      <p className="text-xs leading-relaxed text-text-muted">
        At least 12 characters. This becomes the sign-in for{" "}
        <span className="font-medium text-text">{email}</span>.
      </p>
    </form>
  );
}
