import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";

/**
 * "You're in" - what the person who just accepted an invite is told.
 *
 * ── THE GAP THIS FILLS ──────────────────────────────────────────────────────
 *
 * `/auth/callback` has set `?joined=1` on the landing redirect since 0137, for
 * both the workspace and the superadmin flow. Nothing ever read it. So the end
 * of the invite journey was a dashboard appearing with no acknowledgement of
 * any kind: no confirmation that the link had been spent, that the session was
 * real, or which address it belongs to. People who are not sure whether they
 * are signed in sign in again, and a second pass at a single-use link lands on
 * "this invite link isn't valid" - which reads as "you were refused".
 *
 * ── WHY IT NAMES THE ADDRESS ────────────────────────────────────────────────
 *
 * An invite is bound to one address (0137: acceptance requires the Google
 * account's verified email to equal the invited one), and a person with a work
 * and a personal Google account in the same browser has no other way to tell
 * WHICH one the console now considers them. Saying it here is also the honest
 * answer to "who am I logged in as", the question the account menu otherwise
 * only answers on being opened.
 *
 * ── NO COLOUR, AND NO TOAST ─────────────────────────────────────────────────
 *
 * A plain Card. Green would be a new hue in a console where colour is
 * functional and spent (red means MISSED, orange means error), and nothing here
 * is a state. And not a toast: this is the one thing on screen the person may
 * actually want to read twice, and a message that removes itself after four
 * seconds is one they will read half of.
 *
 * It lasts until the next navigation, because `joined=1` does. That is the
 * right lifetime - it is an acknowledgement, not a task - and it means there is
 * no dismissal to store, nothing to remember per person, and no way for it to
 * come back on a later visit.
 */
export function JoinedNotice({
  email,
  /** Where this console's own Login activity page lives (doc 27 §5.4). */
  activityHref,
  /** The workspace just joined. Absent for a superadmin invite, which has none. */
  workspace,
  /**
   * Whether anybody was told. True in a workspace, where 0152 rings the
   * inviter and the owners; false for a superadmin invite, which notifies
   * nobody - platform operators have no `users` row and so no bell. Its own
   * prop rather than inferred from `workspace`, because a sentence claiming
   * somebody was told when nobody was is worse than saying nothing.
   */
  announced = false,
}: {
  email: string | null;
  activityHref: string;
  workspace?: string | null;
  announced?: boolean;
}) {
  return (
    <Card>
      <MonoLabel>You&rsquo;re in</MonoLabel>
      <p className="mt-1 text-sm text-text-muted">
        {workspace ? `You've joined ${workspace} and are` : "You're"} signed in
        {email ? (
          <>
            {" as "}
            <span className="text-text">{email}</span>
          </>
        ) : null}
        .{announced ? " The people who invited you have been told." : ""} You can see your own
        sign-ins any time on{" "}
        <Link href={activityHref} className="underline hover:text-text">
          Login activity
        </Link>
        .
      </p>
    </Card>
  );
}
