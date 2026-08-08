"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@aura/ui";
import { signOutAction } from "@/app/login/actions";

/** Ends the Supabase session; the action redirects to /login. */
export function SignOutButton({ className = "" }: { className?: string }) {
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
      className={`w-full ${className}`}
    >
      {/* Hidden while loading so the row is not icon + spinner + text. */}
      {pending ? null : <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
