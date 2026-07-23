import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign In — Aura Platform" };

const HIGHLIGHTS = [
  "Call capture across your enrolled device fleet",
  "Diarized transcripts with AI intent + sentiment",
  "CRM dispatch, retention policy and audit trail",
];

/**
 * Sign-in page. Single column on phones; the brand panel appears alongside the
 * form from lg up rather than stacking on top of it, so the form stays above
 * the fold on short viewports.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="min-h-dvh flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md lg:max-w-4xl grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8 items-center">
        {/* Brand panel — desktop only; phones get the compact header in the card. */}
        <div className="hidden lg:flex flex-col gap-6 pr-2">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-black text-white flex items-center justify-center font-bold font-display text-2xl select-none">
              A
            </div>
            <div>
              <h1 className="text-xl font-display font-black uppercase tracking-tighter leading-none">
                Aura Platform
              </h1>
              <MonoLabel className="mt-1.5">Call Intelligence</MonoLabel>
            </div>
          </div>

          <p className="text-4xl xl:text-5xl font-display font-black uppercase tracking-tighter leading-[0.95]">
            Every call,
            <br />
            accounted for.
          </p>

          <ul className="space-y-2.5">
            {HIGHLIGHTS.map((h) => (
              <li key={h} className="flex items-start gap-2.5 text-sm font-sans text-neutral-600">
                <span className="w-2 h-2 bg-black shrink-0 mt-1.5" />
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </div>

        <Card shadow className="w-full space-y-5">
          {/* Compact brand lockup — the panel above replaces it from lg up. */}
          <div className="flex items-center gap-3 lg:hidden">
            <div className="w-10 h-10 bg-black text-white flex items-center justify-center font-bold font-display text-xl select-none">
              A
            </div>
            <div>
              <h1 className="text-sm font-display font-black uppercase tracking-tight leading-none">
                Aura Platform
              </h1>
              <MonoLabel className="mt-1">Call Intelligence</MonoLabel>
            </div>
          </div>

          <div className="hidden lg:block">
            <h2 className="text-2xl font-display font-black uppercase tracking-tight leading-none">
              Sign In
            </h2>
            <MonoLabel className="mt-1.5">Workspace access</MonoLabel>
          </div>

          {AUTH_ENABLED ? null : (
            <p className="text-xs font-mono font-bold uppercase text-black border-2 border-black bg-yellow-100 p-3 leading-relaxed">
              Supabase auth not configured — set NEXT_PUBLIC_SUPABASE_URL and
              NEXT_PUBLIC_SUPABASE_ANON_KEY, then restart the web app.
            </p>
          )}

          <LoginForm next={next} configured={AUTH_ENABLED} />
        </Card>
      </div>
    </main>
  );
}
