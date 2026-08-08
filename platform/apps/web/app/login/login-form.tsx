"use client";

import { useState, useTransition } from "react";
import { AlertCircle, Lock } from "lucide-react";
import { Button, FormField, Input } from "@aura/ui";
import { signInAction } from "./actions";

/**
 * Supabase email + password sign-in.
 *
 * Uses a real <form> so browser password managers and the mobile keyboard's
 * "Go" key both work; the submit runs the server action, which sets the session
 * cookies and redirects on success (so there is no success state to render).
 *
 * v2 note: the fields are <FormField> + <Input> rather than `inputClass` from
 * lib/form. That drops the last hard offset shadow in the console
 * (`focus:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]`, doc 18 §3) and replaces it
 * with the kit's global :focus-visible ring — which is the affordance the whole
 * v2 system now leans on. lib/form is left alone; other route groups still use
 * it and are being migrated separately.
 */
export function LoginForm({ next, configured }: { next?: string; configured: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const res = await signInAction(
        String(formData.get("email") ?? ""),
        String(formData.get("password") ?? ""),
        next,
      );
      if (res?.error) setError(res.error);
    });
  };

  const disabled = pending || !configured;

  return (
    <form action={onSubmit} className="space-y-4">
      <FormField label="Email" name="email" required>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={disabled}
          placeholder="you@company.com"
        />
      </FormField>

      <FormField label="Password" name="password" required>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          disabled={disabled}
          placeholder="••••••••"
        />
      </FormField>

      <Button type="submit" size="lg" className="w-full" loading={pending} disabled={disabled}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text"
        >
          <AlertCircle aria-hidden="true" className="mt-px h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      ) : null}

      <p className="flex items-center gap-1.5 pt-1 text-xs text-text-muted">
        <Lock aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span>Secured by Supabase Auth</span>
      </p>
    </form>
  );
}
