"use client";

import { useState, useTransition } from "react";
import { BrutalButton, Card, MonoLabel } from "@aura/ui";
import { loginAction } from "./actions";

const inputClass =
  "w-full p-2.5 border-2 border-black bg-neutral-50 rounded-none text-sm font-sans text-black focus:outline-none";

/**
 * Dev credential login (seeded: admin@aura.local / admin). Real OIDC swaps in
 * at the /auth/login endpoint; the session + RBAC model behind it is already live.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("admin@aura.local");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<{ error?: string; role?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      setResult(await loginAction(email, password));
    });

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <Card shadow className="w-full max-w-sm space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-black text-white flex items-center justify-center font-bold font-display text-xl">
            A
          </div>
          <div>
            <h1 className="text-sm font-display font-black uppercase tracking-tight leading-none">
              Aura Platform
            </h1>
            <MonoLabel className="mt-1">Call Intelligence</MonoLabel>
          </div>
        </div>

        <div className="space-y-3">
          <input className={inputClass} placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            className={inputClass}
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>

        <BrutalButton className="w-full" shadow disabled={pending} onClick={submit}>
          {pending ? "SIGNING IN..." : "Sign In"}
        </BrutalButton>

        {result?.error ? (
          <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
            {result.error}
          </p>
        ) : result?.role ? (
          <p className="text-xs font-mono font-bold uppercase text-black border-2 border-black bg-neutral-50 p-3">
            Signed in as {result.role} — session established ✓
          </p>
        ) : null}

        <p className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider">
          Dev: admin@aura.local / admin · OIDC/SSO swaps in here
        </p>
      </Card>
    </main>
  );
}
