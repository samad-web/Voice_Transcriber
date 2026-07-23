"use client";

import { useState, useTransition } from "react";
import { AlertCircle, Loader2, Lock } from "lucide-react";
import { BrutalButton } from "@aura/ui";
import { inputClass } from "@/lib/form";
import { signInAction } from "./actions";

/** MonoLabel's look, as a <span> — a <p> is not valid inside a <label>. */
const labelClass =
  "block text-[10px] font-mono text-neutral-400 uppercase tracking-[0.2em] font-bold";

const fieldClass =
  `${inputClass} py-3 placeholder:text-neutral-400 focus:bg-white ` +
  "focus:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-shadow disabled:opacity-50";

/**
 * Supabase email + password sign-in.
 *
 * Uses a real <form> so browser password managers and the mobile keyboard's
 * "Go" key both work; the submit runs the server action, which sets the session
 * cookies and redirects on success (so there is no success state to render).
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

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="email" className={labelClass}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={pending || !configured}
          placeholder="you@company.com"
          className={fieldClass}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className={labelClass}>
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          disabled={pending || !configured}
          placeholder="••••••••"
          className={fieldClass}
        />
      </div>

      <BrutalButton type="submit" className="w-full" shadow disabled={pending || !configured}>
        {pending ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
          </span>
        ) : (
          "Sign In"
        )}
      </BrutalButton>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-px" />
          <span className="break-words">{error}</span>
        </p>
      ) : null}

      <p className="flex items-center gap-1.5 text-[10px] font-mono text-neutral-400 uppercase tracking-wider font-bold pt-1">
        <Lock className="h-3 w-3 shrink-0" />
        <span>Secured by Supabase Auth</span>
      </p>
    </form>
  );
}
