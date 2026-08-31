import { Card, MonoLabel } from "@aura/ui";
import { SignOutButton } from "@/components/sign-out-button";

/**
 * The terminal state for a signed-in account that is neither an owner nor a
 * platform operator.
 *
 * Shown rather than redirected: the middleware bounces a signed-in user off
 * /login, so sending them there would just ping-pong.
 *
 * Lives here because every route group that gates on `isOperator()` must render
 * the identical thing - if one group grew a friendlier fallback it would read as
 * a different, softer answer to the same refusal.
 */
export function NoConsoleAccess({ email }: { email: string }) {
  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <Card elevated className="max-w-md space-y-4">
        <MonoLabel>No console access</MonoLabel>
        <p className="text-sm leading-relaxed text-text-muted">
          {email} is signed in but is not linked to an instance. Ask your
          provider to create an owner login for your company.
        </p>
        <SignOutButton />
      </Card>
    </main>
  );
}
