import type { Metadata } from "next";
import { LoginActivity } from "@/components/login-activity";
import { PageHeader } from "@/components/page-header";
import { accountPageRoles } from "@/lib/account-menu";
import { requireOwnerRoles } from "@/lib/owner-context";
import { getSessionUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Login activity" };

/**
 * Login activity (doc 27 §5.4) - the signed-in person's OWN sign-ins, across
 * every workspace they belong to. Whose history it is comes from the verified
 * session's subject and nothing else; there is no parameter that could name
 * another person, and the API binds every read to that subject.
 */
export default async function LoginActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const owner = await requireOwnerRoles(accountPageRoles("login_activity"));
  const { cursor } = await searchParams;
  const session = await getSessionUser();

  return (
    <>
      <PageHeader
        title="Login activity"
        context="Account"
        description="Sign-ins to your account in the last 90 days, across every workspace."
      />
      <LoginActivity
        authUserId={owner.subject || null}
        currentSessionId={session?.sessionId ?? null}
        cursor={cursor ?? null}
        basePath="/owner/account/login-activity"
        timeZone={owner.membership.reportingTimezone || "Asia/Kolkata"}
      />
    </>
  );
}
