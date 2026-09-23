import type { Metadata } from "next";
import { Card } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { PasswordCard } from "@/components/password-card";
import { PreferencesCard } from "@/components/preferences-card";
import { getPrincipal } from "@/lib/owner-context";
import { AUTH_ENABLED } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Profile" };

/**
 * An operator's Profile (doc 27 §4.1). Operators are a Supabase login with no
 * `users` row (auth-principal.ts) and `platform_operators` has no name column,
 * so there is no name to edit here and none is invented: the email is shown
 * read-only, and the password and preferences cards are the same as the owner
 * console's. The password change is Supabase-only - no API route involved.
 *
 * It reads no tenant data, so it carries no operatorGate() of its own (see
 * platform-pages.guard.test.ts); the layout's isOperator() decides what shows.
 */
export default async function OperatorProfilePage() {
  const principal = await getPrincipal();

  return (
    <>
      <PageHeader title="Profile" context="Account" />
      <Card className="space-y-2">
        <h2 className="text-base font-semibold text-text">Your details</h2>
        <p className="text-xs font-semibold tracking-wide text-text-subtle uppercase">Email</p>
        <p className="truncate text-sm text-text">{principal?.email || "Not signed in"}</p>
        <p className="text-xs text-text-muted">
          Operator accounts are managed on the Superadmins page by the root operator.
        </p>
      </Card>
      <PasswordCard enabled={AUTH_ENABLED} />
      <PreferencesCard />
    </>
  );
}
