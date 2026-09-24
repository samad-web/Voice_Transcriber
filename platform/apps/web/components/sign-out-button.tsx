"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@aura/ui";
import { signOutAction } from "@/app/login/actions";

/**
 * Ends the Supabase session; the action redirects to /login.
 *
 * `iconOnly` is the collapsed sidebar's form: at icon-rail width the words
 * "Sign out" wrapped onto two lines inside a pill. The name moves to
 * aria-label and a native tooltip, same as every other icon-only control.
 */
export function SignOutButton({ className = "", iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      // Explicit: <Button> deliberately does not default `type`, because several
      // console forms rely on the HTML default of "submit".
      type="button"
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() => startTransition(() => signOutAction())}
      aria-label={iconOnly ? (pending ? "Signing out" : "Sign out") : undefined}
      title={iconOnly ? "Sign out" : undefined}
      className={`w-full ${className}`}
    >
      {/* Hidden while loading so the row is not icon + spinner + text. */}
      {pending ? null : <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {iconOnly ? null : pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
