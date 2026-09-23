import type { Metadata } from "next";
import { LoginActivity } from "@/components/login-activity";
import { PageHeader } from "@/components/page-header";
import { getPrincipal } from "@/lib/owner-context";
import { getSessionUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Login activity" };

/**
 * An operator's own sign-in history (doc 27 §5.4). The same table as the owner
 * console's, bound to the same thing: the verified session's subject. An
 * operator's times are shown in IST - they have no workspace timezone.
 *
 * No operatorGate() here, deliberately (platform-pages.guard.test.ts): the gate
 * exists to stop a render-path read of TENANT data with the root admin key
 * before the layout's check lands. This page reads no tenant's data - its one
 * request is bound to the caller's own subject - so even a non-operator who
 * reached the render would see only their own history. The layout's
 * isOperator() decides what is shown.
 */
export default async function OperatorLoginActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const principal = await getPrincipal();
  const session = await getSessionUser();
  const { cursor } = await searchParams;

  return (
    <>
      <PageHeader
        title="Login activity"
        context="Account"
        description="Sign-ins to your account in the last 90 days, across every workspace."
      />
      <LoginActivity
        authUserId={principal?.subject || null}
        currentSessionId={session?.sessionId ?? null}
        cursor={cursor ?? null}
        basePath="/account/login-activity"
        timeZone="Asia/Kolkata"
      />
    </>
  );
}
