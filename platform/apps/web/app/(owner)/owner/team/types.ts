import type { OwnerRole } from "@aura/shared";

/** One row of `GET /v1/owner/team` - a person, and what they can do here. */
export interface TeamMember {
  userId: string;
  email: string;
  name: string | null;
  /** The OPERATOR-side tenant role (memberships.role), shown for reference
   *  only. Changing it is the provider's job, not the customer's - see
   *  migration 0018's header for why the two axes stay separate. */
  role: string;
  ownerRole: OwnerRole;
  recordingsListen: boolean;
  recordingsExport: boolean;
  /** May this person pair a handset? (migration 0107) Owner-granted, per
   *  person. Always effectively true for the `owner` persona whatever the
   *  column says - see canPairDevices() in @aura/shared. */
  canPairDevices: boolean;
  /** The `telecallers` row this login resolves to, if any. Own-scoped
   *  personas read their records through it (owner-scope.ts). */
  telecallerId: string | null;
  telecallerName: string | null;
}

/** A telecaller identity a person can be bound to. */
export interface TeamTelecaller {
  id: string;
  displayName: string;
  externalId: string | null;
  /** Whose login already resolves to this identity, if anyone's. */
  userId: string | null;
}

export interface TeamResponse {
  members: TeamMember[];
  telecallers: TeamTelecaller[];
}
