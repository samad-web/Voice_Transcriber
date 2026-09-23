import { PageHeader } from "@/components/page-header";
import { IntroSkeleton, TableBlockSkeleton } from "@/components/skeletons";

/** Mirrors account/login-activity/page.tsx: the intro line with its action, then the five-column table. */
export default function LoginActivityLoading() {
  return (
    <>
      <PageHeader
        title="Login activity"
        context="Account"
        description="Sign-ins to your account in the last 90 days, across every workspace."
      />
      <IntroSkeleton lines={1} action />
      <TableBlockSkeleton columns={["date", "chip", "text", "num", "text"]} rows={8} />
    </>
  );
}
