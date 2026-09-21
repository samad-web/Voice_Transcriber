import { LoadFailure } from "@/components/load-failure";
import { ownerTry } from "@/lib/owner-context";
import { RolesGrid } from "./roles-grid";
import type { RolesResponse } from "./types";

/**
 * Roles & permissions - what somebody may DO with a record they can see.
 *
 * ── THE TWO AXES, SAID ONCE, HERE ─────────────────────────────────────────
 *
 * This console has two independent controls over access and the difference is
 * the thing everybody gets wrong:
 *
 *   Role (persona)    which console you get, and WHOSE records are in it.
 *                     Five values, set on the Team tab.
 *   Permission role   what you may do with a record - view, create, edit,
 *                     delete, export - per object type. Editable here, and a
 *                     workspace can define its own.
 *
 * Both must say yes, and they compose in one direction only: a persona can
 * narrow a grant and can never widen one. A telecaller handed a role granting
 * "view every deal" still sees only their own, because `CrmPermissionsGuard`
 * intersects the two. That is why this tab cannot be used to hand somebody the
 * whole floor by the back door, and it is worth the paragraph.
 *
 * ── AND WHY THIS TAB CANNOT LOCK ITSELF OUT ───────────────────────────────
 *
 * `GET /v1/owner/roles` and every write behind it are gated on the PERSONA,
 * never on the grid they edit. An owner who saves an empty grid loses the CRM
 * object pages and still reaches this tab to undo it - which would not be true
 * if the repair were behind the thing being repaired.
 */
export async function RolesTab({ canEdit }: { canEdit: boolean }) {
  const result = await ownerTry<RolesResponse>("/v1/owner/roles");

  if (!result.ok) {
    return <LoadFailure what="roles and permissions" failure={result} />;
  }
  const data = result.data;

  return (
    <>
      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
        A role decides what somebody may do with a record. Which records they see at all is their{" "}
        <strong className="font-medium text-text">role on the Team tab</strong> — both have to allow
        it, and a restricted role never widens what the team role permits.
      </p>

      <RolesGrid
        roles={data.roles}
        objectTypes={data.objectTypes}
        actions={data.actions}
        canEdit={canEdit}
      />

      {!canEdit ? (
        <p className="text-sm text-text-muted">
          Only an Owner can change these. Ask one if somebody needs different access.
        </p>
      ) : null}
    </>
  );
}
