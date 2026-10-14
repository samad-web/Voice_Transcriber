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
  /**
   * May this colleague pair a handset (`memberships.can_pair_devices`,
   * migration 0107)? `/owner/devices` reads it to enable or disable the
   * pair button.
   *
   * Inert for an owner: `canPairDevices()` in @aura/shared returns true for
   * that persona whatever the column says, so a workspace can never reach a
   * state where nobody is able to add a phone.
   */
  canPairDevices: boolean;
  /** The `telecallers` row this login resolves to, if any. Own-scoped
   *  personas read their records through it (owner-scope.ts). */
  telecallerId: string | null;
  telecallerName: string | null;
  /**
   * `active` | `archived` (0198). Archived means the desk takes no new routed
   * leads - which is what suspension now does to it, and what offboarding
   * does on the way out. Shown rather than hidden: a roster that rendered a
   * suspended colleague as having no identity at all invites somebody to bind
   * them a second one, and every call and lead they ever had hangs off the
   * first.
   */
  telecallerStatus: "active" | "archived" | null;

  // ── The staff record (migration 0102) ──
  status: StaffStatus;
  staffCode: string | null;
  phone: string | null;
  /** WhatsApp number (0135) - often the same as `phone`. */
  whatsapp: string | null;
  jobTitle: string | null;
  suspendedAt: string | null;
  /** The permission role whose grid applies (0039's `memberships.role_id`). */
  roleId: string | null;
  roleName: string | null;
  roleKey: string | null;
}

/**
 * What somebody still holds - `GET /v1/owner/team/:userId/offboard` (0198).
 *
 * Counts, not records. The dialog's job is to let an owner decide where a
 * departing colleague's desk goes, and a hundred and twelve lead titles would
 * bury the one number that decision turns on.
 */
export interface OffboardWork {
  leads: number;
  dealsOwned: number;
  dealsDesk: number;
  contacts: number;
  accounts: number;
  callbacks: number;
  tasks: number;
  taskSeats: number;
  conversations: number;
}

export interface OffboardDevice {
  id: string;
  label: string | null;
  status: string;
  calls: number;
}

/** A routing rule they are a target of. `othersActive: 0` is the warning. */
export interface OffboardRule {
  id: string;
  name: string;
  status: string;
  othersActive: number;
}

export interface OffboardManifest {
  member: {
    userId: string;
    email: string;
    name: string | null;
    ownerRole: string | null;
    status: string;
    telecallerId: string | null;
    telecallerName: string | null;
    telecallerStatus: string | null;
  };
  devices: OffboardDevice[];
  work: OffboardWork;
  rules: OffboardRule[];
  unreadNotifications: number;
  /** Leads are assigned to a telecaller identity, so the recipient needs one. */
  needsTelecallerRecipient: boolean;
  total: number;
}

export interface OffboardResult {
  manifest: OffboardManifest;
  moved: OffboardWork;
  devices: Array<OffboardDevice & { outcome: string }>;
  telecallerArchived: boolean;
  notificationsCleared: number;
  recipient: { userId: string; email: string; telecallerId: string | null } | null;
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

/** An invite that has not been accepted or withdrawn - `GET /v1/owner/invites` (0137). */
export interface TeamInvite {
  id: string;
  email: string;
  name: string | null;
  ownerRole: OwnerRole;
  status: "pending" | "expired";
  expiresAt: string;
  createdAt: string;
  emailedAt: string | null;
  invitedByName: string | null;
}

export interface InvitesResponse {
  invites: TeamInvite[];
  /** PLATFORM_SMTP_* is set - "Email it" would work. */
  mailConfigured: boolean;
  /** The API can reach GoTrue - an invite could be accepted at all. */
  authConfigured: boolean;
}

/** What issuing or resending returns. `link` is shown once; only its hash is stored. */
export interface IssuedInvite {
  invite: TeamInvite;
  link: string;
  emailed: boolean;
  emailError: string | null;
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
