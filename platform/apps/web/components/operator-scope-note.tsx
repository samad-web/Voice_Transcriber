import { Card, MonoLabel } from "@aura/ui";

/**
 * "You are looking at a subset" - said out loud, on every scoped screen.
 *
 * ── WHY A FILTERED LIST MUST ANNOUNCE ITSELF ────────────────────────────────
 *
 * Doc 49 P13b puts the operator console's cross-tenant reads behind
 * `operatorScopeSql`, so a superadmin sees the clients they onboarded. The
 * mechanism is in the API. This component is the half that makes it usable, and
 * it is not decoration:
 *
 *   - a short list with no caption reads as "this is everything". An operator
 *     who sees four clients where there are nineteen has no way to know whether
 *     the platform shrank, the query broke, or the filter is working;
 *   - the empty case is worse. "No instances yet - create one to onboard your
 *     first customer" is TRUE for a new platform and FALSE for a superadmin
 *     with no attributed clients, and the two states look identical. The
 *     second person goes looking for an outage.
 *
 * ── THE WORDING IS LOAD-BEARING ─────────────────────────────────────────────
 *
 * "Showing your clients only", never "only you can see this". The scope is a
 * console-tier filter, not containment of a hostile superadmin: every operator
 * holds - or can reach - `ADMIN_API_KEY`, which is cross-tenant by design, so a
 * filtered operator can still read another's client by calling the API
 * directly. `operator-scope.ts` states this at length, and
 * `operator-scope.spec.ts` asserts the caption never claims exclusivity.
 * Promising privacy the system does not provide is the one thing this box must
 * not do.
 *
 * ── NO COLOUR ───────────────────────────────────────────────────────────────
 *
 * A plain Card, like JoinedNotice. This is not a state and not a warning - red
 * means MISSED CALL in this console and orange means error. A scoped list is
 * the normal, intended condition of a superadmin's screen.
 */
export function OperatorScopeNote({
  /** `scope` from the API: "all", "onboarded_by" or "none". */
  scope,
  /** `scopeNote` from the API - `describeScope`'s one line. Null for the root. */
  note,
  /**
   * What this screen lists, lower-case and plural - "clients", "tickets",
   * "adoption rows". Named per screen rather than hardcoded, because a reader
   * on the escalation queue needs to know it is the TICKETS that are filtered,
   * not some other list on the page.
   */
  subject = "clients",
}: {
  scope: string | null | undefined;
  note: string | null | undefined;
  subject?: string;
}) {
  // The root, or the switch still off. Nothing is filtered, so there is nothing
  // to say - and a caption on an unfiltered screen would be noise that teaches
  // people to ignore the one on a filtered screen.
  if (!note || scope === "all" || !scope) return null;

  const nobody = scope === "none";

  return (
    <Card>
      <MonoLabel>{nobody ? "Nothing attributed to you" : "Your clients"}</MonoLabel>
      <p className="mt-1 text-sm text-text-muted">
        {nobody ? (
          <>
            No {subject} are attributed to this account, so this list is empty. That is a missing
            attribution rather than an empty platform - ask the root operator to record you as the
            onboarder of the {subject} you manage.
          </>
        ) : (
          <>
            Showing the {subject} you onboarded. Others exist and are managed by other operators;
            this is a view of your own book, not a restriction on what the platform holds.
          </>
        )}
      </p>
    </Card>
  );
}
