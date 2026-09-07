import type { OwnerRole, StaffScorecardRow, StaffStatus } from "@aura/shared";

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
  /** The `telecallers` row this login resolves to, if any. Own-scoped
   *  personas read their records through it (owner-scope.ts). */
  telecallerId: string | null;
  telecallerName: string | null;

  // ── The staff record (migration 0102) ──
  status: StaffStatus;
  staffCode: string | null;
  phone: string | null;
  jobTitle: string | null;
  suspendedAt: string | null;
  /** The permission role whose grid applies (0039's `memberships.role_id`). */
  roleId: string | null;
  roleName: string | null;
  roleKey: string | null;
}

/** A role a member can be moved to - the picker on the Team tab. */
export interface TeamRole {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
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
  roles: TeamRole[];
}

/** One role and its grants - `GET /v1/owner/roles`. */
export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  status: "active" | "archived";
  member_count: number;
  grants: Array<{
    objectType: string;
    action: string;
    scope: "all" | "owned";
    fieldRestrictions: Record<string, string>;
  }>;
}

export interface RolesResponse {
  roles: RoleRow[];
  /** The matrix axes, from the API rather than from a copy in this bundle - a
   *  checkbox for an object the API does not know about writes a grant nothing
   *  will ever read. */
  objectTypes: string[];
  actions: string[];
}

export interface PerformanceResponse {
  from: string;
  to: string;
  sort: string;
  staff: Array<StaffScorecardRow & { callsReceived: number | null; followupsDue: number | null }>;
}
