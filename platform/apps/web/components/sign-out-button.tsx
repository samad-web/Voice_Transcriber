"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { signOutAction } from "@/app/login/actions";

/** Ends the Supabase session; the action redirects to /login. */
export function SignOutButton({ className = "" }: { className?: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => signOutAction())}
      className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-black bg-white text-black text-[10px] font-display font-bold uppercase tracking-wider rounded-none transition-colors hover:bg-black hover:text-white disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      <LogOut className="h-3.5 w-3.5" />
      {pending ? "Signing out…" : "Sign Out"}
    </button>
  );
}
