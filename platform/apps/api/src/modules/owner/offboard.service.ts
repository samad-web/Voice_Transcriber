import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { removeDevice } from "../devices/device-rebind";
import { CallbacksService, type CallbackRow } from "../callbacks/callbacks.service";

/**
 * Somebody left. This is what the product does about it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Offboarding was treated as a LOGIN event for the whole life of this product,
 * and it is a WORK HANDOVER event. Suspension (0102) stopped a person signing
 * in and did nothing else, which left, every single time:
 *
 *  - their handset still recording and still uploading, because device auth is
 *    a separate axis from membership and nothing joined the two (and nothing
 *    should - see `logOutDevices` for why a membership join in the device guard
 *    would kill every unbound and shared phone in the fleet);
 *  - their telecaller identity still `active`, so round-robin went on handing
 *    new leads to a desk nobody was sitting at. `telecallers.status` has had
 *    'archived' since 0017 and every reader honours it; no writer existed;
 *  - their leads, call-backs, tasks, contacts, accounts, deals and shared
 *    threads still assigned to an account that cannot open the console;
 *  - their bell still filling up (0198's trigger ends that half).
 *
 * Every primitive needed already existed. What did not exist was anything
 * that called them in sequence, in one transaction, with a preview first.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE RULES THIS SERVICE KEEPS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **Nothing is attributed away.** Not one historical column is touched:
 * `calls.telecaller_id`, `leads.telecaller_id` (0017's deliberate snapshot),
 * `*_by`, `created_by`, `original_user_id` on a call-back. Who did the work
 * stays who did the work, forever. Only the columns that mean "whose job is
 * this NOW" move, which is the entire distinction this file turns on.
 *
 * **A person must name the recipient.** There is no "give it to their
 * manager" default. Handing a hundred leads to a manager who did not ask for
 * them, triggered by somebody clicking Suspend, is how a handover becomes
 * invisible - the opposite of the thing being fixed.
 *
 * **Private threads are not transferable.** A chat that arrived on somebody's
 * own WhatsApp number is theirs (0125), and an offboarding is not a
 * disclosure event. Only `private_to_user_id IS NULL` threads move; the
 * private ones stop at the channel instead, which is what
 * `retirePersonalChannel` already does on removal. The database agrees, as it
 * happens - `conversations` carries a CHECK that a private thread's
 * `assigned_user_id` equals its `private_to_user_id`, so a handover that
 * forgot this clause would not leak quietly, it would 23514 on the first
 * private thread. The clause is still the point; the CHECK is the net.
 *
 * **Billing is not in scope.** Quotations, invoices, payments and the finance
 * module keep their `owner_user_id` exactly as it is. A document with money on
 * it has a named author for a reason, and re-pointing one as a side effect of
 * an HR action is not a thing this service gets to decide.
 *
 * **Task seats are offered, not imposed.** The records above simply become the
 * recipient's. A task seat moves as `pending`, because 0135 made being given
 * work something a person may decline, and inheriting a colleague's task list
 * is precisely when that matters.
 */

interface DbClient {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
}

/** What to do with the handsets bound to this person. */
export type DeviceDisposition = "logout" | "remove" | "keep";

export interface OffboardMember {
  userId: string;
  email: string;
  name: string | null;
  ownerRole: string | null;
  status: string;
  telecallerId: string | null;
  telecallerName: string | null;
  telecallerStatus: string | null;
}

export interface OffboardDevice {
  id: string;
  label: string | null;
  status: string;
  calls: number;
}

/**
 * A routing rule this person is a target of, and how many OTHER active targets
 * it has.
 *
 * `othersActive: 0` is the one state worth showing a human: archiving the
 * identity empties the rule, and `pickRoundRobin` with no candidates returns
 * `picked: null` with a refusal reason, so every matching lead lands
 * unassigned. It is recorded, not silent - but nobody is watching the reason
 * field, so the dialog says it out loud.
 *
 * Deliberately a warning and not a refusal. Blocking a departure over a
 * distribution rule would be the wrong trade; the leads keep arriving either
 * way, and the fix is one click on the Routing page.
 */
export interface OffboardRule {
  id: string;
  name: string;
  status: string;
  othersActive: number;
}

/** Everything this person currently holds, by bucket. */
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

export interface OffboardManifest {
  member: OffboardMember;
  devices: OffboardDevice[];
  work: OffboardWork;
  rules: OffboardRule[];
  unreadNotifications: number;
  /** Does any of the outstanding work need a TELECALLER identity to receive it? */
  needsTelecallerRecipient: boolean;
  total: number;
}

export interface OffboardResult {
  manifest: OffboardManifest;
  moved: OffboardWork;
  devices: Array<OffboardDevice & { outcome: "logged_out" | "deleted" | "de-enrolled" | "kept" }>;
  telecallerArchived: boolean;
  notificationsCleared: number;
  recipient: { userId: string; email: string; telecallerId: string | null } | null;
}

/**
 * The record columns that move, as data.
 *
 * Table-driven because the list is the interesting part and it will grow:
 * writing seven near-identical UPDATEs out by hand is how the eighth object
 * type gets added to the console and forgotten here, which is the exact class
 * of bug this whole service is fixing.
 *
 * `extra` is ANDed in. It is never a scope filter - this service runs under
 * `@RequireOwnerRole("owner")` and RLS pins the org - it is about what the
 * column means: an open task is work, a closed one is history, and a private
 * thread is not anybody's to hand on.
 */
const USER_OWNED: ReadonlyArray<{
  bucket: keyof OffboardWork;
  table: string;
  column: string;
  extra?: string;
  auditAction: string;
  targetType: string;
}> = [
  { bucket: "contacts", table: "contacts", column: "owner_user_id", auditAction: "contact.reassign", targetType: "contact" },
  { bucket: "accounts", table: "accounts", column: "owner_user_id", auditAction: "account.reassign", targetType: "account" },
  { bucket: "dealsOwned", table: "deals", column: "owner_user_id", auditAction: "deal.reassign", targetType: "deal" },
  {
    bucket: "tasks",
    table: "tasks",
    column: "assignee_user_id",
    extra: "r.status = 'open'",
    auditAction: "task.reassign",
    targetType: "task",
  },
  {
    bucket: "conversations",
    table: "conversations",
    column: "assigned_user_id",
    // 0125. The private ones are not transferable at any permission level.
    extra: "r.private_to_user_id IS NULL",
    auditAction: "conversation.reassign",
    targetType: "conversation",
  },
];

/** The same, for the columns keyed on a TELECALLER identity rather than a login. */
const TELECALLER_OWNED: ReadonlyArray<{
  bucket: keyof OffboardWork;
  table: string;
  column: string;
  auditAction: string;
  targetType: string;
}> = [
  { bucket: "leads", table: "leads", column: "assigned_telecaller_id", auditAction: "lead.reassign", targetType: "lead" },
  { bucket: "dealsDesk", table: "deals", column: "assigned_telecaller_id", auditAction: "deal.reassign", targetType: "deal" },
];

/** Open call-backs: the ones somebody is still expected to make. */
const OPEN_CALLBACKS = "'scheduled', 'due', 'reminded', 'in_progress', 'missed', 'escalated'";

const EMPTY_WORK: OffboardWork = {
  leads: 0,
  dealsOwned: 0,
  dealsDesk: 0,
  contacts: 0,
  accounts: 0,
  callbacks: 0,
  tasks: 0,
  taskSeats: 0,
  conversations: 0,
};

@Injectable()
export class OffboardService {
  constructor(private readonly callbacks: CallbacksService) {}

  /**
   * What would move, without moving it.
   *
   * The dialog's dry run AND the execute path's own first step, so the audit
   * row and the confirmation screen can never disagree about what happened.
   */
  async manifest(client: DbClient, orgId: string, userId: string): Promise<OffboardManifest> {
    const member = await this.loadMember(client, orgId, userId);
    const telecallerId = member.telecallerId;

    const {
      rows: [counts],
    } = await client.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM contacts      WHERE org_id = $1 AND owner_user_id    = $2) AS contacts,
         (SELECT count(*) FROM accounts      WHERE org_id = $1 AND owner_user_id    = $2) AS accounts,
         (SELECT count(*) FROM deals         WHERE org_id = $1 AND owner_user_id    = $2) AS deals_owned,
         (SELECT count(*) FROM tasks         WHERE org_id = $1 AND assignee_user_id = $2
                                               AND status = 'open')                       AS tasks,
         (SELECT count(*) FROM task_assignees ta
             JOIN tasks t ON t.id = ta.task_id AND t.status = 'open'
            WHERE ta.org_id = $1 AND ta.user_id = $2
              AND ta.status IN ('pending', 'accepted'))                                   AS task_seats,
         (SELECT count(*) FROM conversations WHERE org_id = $1 AND assigned_user_id = $2
                                               AND private_to_user_id IS NULL)            AS conversations,
         (SELECT count(*) FROM leads         WHERE org_id = $1
                                               AND assigned_telecaller_id = $3::uuid)     AS leads,
         (SELECT count(*) FROM deals         WHERE org_id = $1
                                               AND assigned_telecaller_id = $3::uuid)     AS deals_desk,
         (SELECT count(*) FROM callbacks     WHERE org_id = $1
                                               AND status IN (${OPEN_CALLBACKS})
                                               AND (assigned_user_id = $2
                                                 OR assigned_telecaller_id = $3::uuid))   AS callbacks,
         (SELECT count(*) FROM notifications WHERE org_id = $1 AND user_id = $2
                                               AND read_at IS NULL)                       AS unread`,
      [orgId, userId, telecallerId],
    );

    const work: OffboardWork = {
      contacts: Number(counts?.contacts ?? 0),
      accounts: Number(counts?.accounts ?? 0),
      dealsOwned: Number(counts?.deals_owned ?? 0),
      dealsDesk: Number(counts?.deals_desk ?? 0),
      leads: Number(counts?.leads ?? 0),
      callbacks: Number(counts?.callbacks ?? 0),
      tasks: Number(counts?.tasks ?? 0),
      taskSeats: Number(counts?.task_seats ?? 0),
      conversations: Number(counts?.conversations ?? 0),
    };

    const devices = telecallerId ? await this.liveDevices(client, orgId, telecallerId) : [];
    const rules = telecallerId ? await this.routingRules(client, orgId, telecallerId) : [];

    return {
      member,
      devices,
      work,
      rules,
      unreadNotifications: Number(counts?.unread ?? 0),
      // `taskSeats` is absent on purpose: a seat moves with its task and a
      // task is user-keyed, so a seat never needs a telecaller to receive it.
      needsTelecallerRecipient: work.leads + work.dealsDesk > 0,
      total: Object.values(work).reduce((sum, n) => sum + n, 0),
    };
  }

  /**
   * Hand the work over, stop the handsets, archive the identity.
   *
   * Called inside `db.withOrg`, which is one transaction (see withOrgContext):
   * either the whole handover lands or none of it does. That matters more here
   * than almost anywhere else in this codebase - a half-applied offboarding
   * leaves a workspace where some of a departed rep's leads are reassigned and
   * the rest are not, and nothing on any screen would say which.
   */
  async execute(
    client: DbClient,
    orgId: string,
    req: PrincipalRequest,
    input: {
      userId: string;
      handoverTo: string | null;
      devices: DeviceDisposition;
      archiveTelecaller: boolean;
    },
  ): Promise<OffboardResult> {
    const actor = auditActor(req);
    const actorUserId = actor.type === "user" ? actor.id : null;
    const manifest = await this.manifest(client, orgId, input.userId);
    const recipient = input.handoverTo
      ? await this.loadRecipient(client, orgId, input.handoverTo, input.userId)
      : null;

    // ── The two refusals that protect the handover itself ──────────────────
    //
    // Both are 400s rather than silent no-ops. "Offboarded, 112 leads
    // untouched" is the state this whole service exists to make unreachable,
    // so it must not be reachable by LEAVING A FIELD BLANK either.
    if (!recipient && manifest.total > 0) {
      throw new BadRequestException(
        "say who this person's work goes to - there is open work on their desk and nothing " +
          "may be left assigned to an account that cannot sign in",
      );
    }
    if (recipient && manifest.needsTelecallerRecipient && !recipient.telecallerId) {
      throw new BadRequestException(
        `${recipient.email} has no telecaller identity, and leads are assigned to one rather ` +
          "than to a login - bind them to one on the Staff tab first, then hand the work over",
      );
    }

    const moved: OffboardWork = { ...EMPTY_WORK };

    if (recipient) {
      for (const spec of USER_OWNED) {
        moved[spec.bucket] = await this.moveColumn(client, orgId, {
          ...spec,
          from: input.userId,
          to: recipient.userId,
          actorId: actor.id,
        });
      }
      if (manifest.member.telecallerId && recipient.telecallerId) {
        for (const spec of TELECALLER_OWNED) {
          moved[spec.bucket] = await this.moveColumn(client, orgId, {
            ...spec,
            from: manifest.member.telecallerId,
            to: recipient.telecallerId,
            actorId: actor.id,
          });
        }
      }
      moved.taskSeats = await this.moveTaskSeats(
        client,
        orgId,
        input.userId,
        recipient.userId,
        actorUserId,
      );
      moved.callbacks = await this.moveCallbacks(client, orgId, req, {
        fromUserId: input.userId,
        fromTelecallerId: manifest.member.telecallerId,
        toUserId: recipient.userId,
        toTelecallerId: recipient.telecallerId,
        who: manifest.member.name ?? manifest.member.email,
      });
    }

    const devices = await this.disposeDevices(client, orgId, manifest.devices, input.devices);

    const telecallerArchived =
      input.archiveTelecaller && Boolean(manifest.member.telecallerId)
        ? await this.archiveTelecaller(client, orgId, input.userId)
        : false;

    // Their unread bell, cleared. 0198's trigger stops NEW rows for a
    // suspended member; this is the backlog already sitting there, which that
    // trigger cannot reach and which nobody will ever open.
    const { rowCount: cleared } = await client.query(
      `UPDATE notifications SET read_at = now()
        WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL`,
      [orgId, input.userId],
    );

    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, $2, $3, 'owner.team.offboard', 'user', $4, $5::jsonb)`,
      [
        orgId,
        actor.type,
        actor.id,
        input.userId,
        JSON.stringify({
          handoverTo: recipient?.userId ?? null,
          handoverToEmail: recipient?.email ?? null,
          moved,
          devices: devices.map((d) => ({ id: d.id, label: d.label, outcome: d.outcome })),
          telecallerArchived,
          telecallerId: manifest.member.telecallerId,
          notificationsCleared: cleared ?? 0,
          // The rules left with nobody in them. Recorded because the
          // consequence - leads arriving unassigned - shows up days later on a
          // different screen, and this is the row that explains it.
          rulesLeftEmpty: manifest.rules.filter((r) => r.othersActive === 0).map((r) => r.name),
        }),
      ],
    );

    if (recipient) await this.tellRecipient(client, orgId, recipient.userId, manifest, moved);

    return {
      manifest,
      moved,
      devices,
      telecallerArchived,
      notificationsCleared: cleared ?? 0,
      recipient: recipient
        ? { userId: recipient.userId, email: recipient.email, telecallerId: recipient.telecallerId }
        : null,
    };
  }

  /**
   * Archive, or bring back, the telecaller identity bound to this person.
   *
   * Exported past `execute` because suspend and reinstate call it on their own
   * (owner-team.controller.ts): a suspension IS "this person is not taking
   * calls", and a desk that goes on receiving round-robin leads while its
   * owner cannot sign in is the single most expensive half of this whole bug.
   *
   * Returns whether anything changed, so the caller can report honestly rather
   * than claiming an archive on a person who never had an identity.
   */
  async setTelecallerArchived(
    client: DbClient,
    orgId: string,
    userId: string,
    archived: boolean,
  ): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE telecallers SET status = $3, updated_at = now()
        WHERE org_id = $1 AND user_id = $2 AND status <> $3`,
      [orgId, userId, archived ? "archived" : "active"],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Log out every live handset bound to this person, and report which.
   *
   * The reversible half of `disposeDevices`, reachable on its own because
   * suspend calls it (owner-team.controller.ts) and suspension must not be
   * able to destroy anything. `logged_out` stops the device authenticating;
   * the console's relink token (0130) brings the same phone back.
   *
   * Resolves the identity WITHOUT a status filter, because the caller has
   * usually just archived it one statement earlier.
   */
  async logOutHandsets(
    client: DbClient,
    orgId: string,
    userId: string,
  ): Promise<OffboardDevice[]> {
    const {
      rows: [row],
    } = await client.query<{ telecaller_id: string }>(
      `SELECT t.id AS telecaller_id FROM telecallers t
        WHERE t.org_id = $1 AND t.user_id = $2
        LIMIT 1`,
      [orgId, userId],
    );
    if (!row) return [];

    const devices = await this.liveDevices(client, orgId, row.telecaller_id);
    for (const device of devices) {
      await client.query(`UPDATE devices SET status = 'logged_out' WHERE id = $1 AND org_id = $2`, [
        device.id,
        orgId,
      ]);
    }
    return devices;
  }

  /**
   * Log out - or remove - the handsets bound to this person.
   *
   * ── WHY THIS IS AN EXPLICIT ACTION AND NOT A GUARD ────────────────────────
   *
   * The tempting fix for "a suspended rep's phone keeps recording" is one line
   * in the device config read: join `memberships` and refuse a suspended one.
   * It would be wrong. `devices.telecaller_id` is NULLABLE and plenty of real
   * handsets are shared or unbound, so a membership join in that path kills
   * every phone that is not tied to one named person - a silent fleet-wide
   * outage caused by an HR action.
   *
   * So the fleet is changed deliberately, on named devices, and the manifest
   * lists them first.
   *
   * `logout` is the default because it is reversible: the console's relink
   * token (0130) brings the same phone back. `remove` goes through
   * `removeDevice`, which holds the rule both consoles must apply identically
   * - hard DELETE when the handset recorded nothing, `removed_at` plus
   * `logged_out` when it did, and never a wipe. Taking a phone off the list
   * must not reach out and erase what is on it.
   */
  private async disposeDevices(
    client: DbClient,
    orgId: string,
    devices: OffboardDevice[],
    disposition: DeviceDisposition,
  ): Promise<OffboardResult["devices"]> {
    const out: OffboardResult["devices"] = [];
    for (const device of devices) {
      if (disposition === "keep") {
        out.push({ ...device, outcome: "kept" });
        continue;
      }
      if (disposition === "remove") {
        const res = await removeDevice(client, device.id);
        out.push({ ...device, outcome: res.outcome });
        continue;
      }
      await client.query(
        `UPDATE devices SET status = 'logged_out' WHERE id = $1 AND org_id = $2`,
        [device.id, orgId],
      );
      out.push({ ...device, outcome: "logged_out" });
    }
    return out;
  }

  private async archiveTelecaller(client: DbClient, orgId: string, userId: string) {
    return this.setTelecallerArchived(client, orgId, userId, true);
  }

  /**
   * One column, moved, with an audit row per record.
   *
   * Per-record and not per-click, which is `bulk-assign.ts`'s rule and the
   * right one: "who moved this contact to Ravi, and when" has to be answerable
   * about the contact, because that is the question somebody actually asks six
   * months later.
   */
  private async moveColumn(
    client: DbClient,
    orgId: string,
    spec: {
      table: string;
      column: string;
      extra?: string;
      from: string;
      to: string;
      actorId: string;
      auditAction: string;
      targetType: string;
    },
  ): Promise<number> {
    const where = [`r.org_id = $1`, `r.${spec.column} = $2::uuid`];
    if (spec.extra) where.push(spec.extra);

    const { rows } = await client.query<{ id: string }>(
      `UPDATE ${spec.table} r SET ${spec.column} = $3::uuid
        WHERE ${where.join(" AND ")}
        RETURNING r.id`,
      [orgId, spec.from, spec.to],
    );
    if (rows.length === 0) return 0;

    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       SELECT $1, 'user', $2, $3, $4, t.id::text, $5::jsonb
         FROM unnest($6::uuid[]) AS t(id)`,
      [
        orgId,
        spec.actorId,
        spec.auditAction,
        spec.targetType,
        JSON.stringify({ [spec.column]: spec.to, offboard: true, from: spec.from }),
        rows.map((r) => r.id),
      ],
    );
    return rows.length;
  }

  /**
   * Their seat on each open multi-assignee task becomes the recipient's
   * (0135).
   *
   * Two statements rather than one clever CTE. `(task_id, user_id)` is the
   * primary key, so when the recipient is ALREADY on one of these tasks the
   * departing seat cannot be re-pointed at them - it has to go. Doing the
   * delete and the update as two data-modifying CTEs in one statement would
   * have both reading the same snapshot, which is how you get an UPDATE
   * silently skipping rows a sibling CTE deleted. Sequential is boring and
   * correct.
   *
   * The moved seat lands `pending`. An owner handing on a colleague's task
   * list is making an offer, and 0135 is explicit that an offer is answerable:
   * the recipient gets Accept / Decline, and declining tells the task's
   * creator rather than silently dropping it.
   */
  private async moveTaskSeats(
    client: DbClient,
    orgId: string,
    fromUserId: string,
    toUserId: string,
    actorUserId: string | null,
  ): Promise<number> {
    await client.query(
      `DELETE FROM task_assignees ta
        WHERE ta.org_id = $1 AND ta.user_id = $2
          AND EXISTS (SELECT 1 FROM tasks t
                       WHERE t.id = ta.task_id AND t.status = 'open')
          AND EXISTS (SELECT 1 FROM task_assignees other
                       WHERE other.task_id = ta.task_id AND other.user_id = $3::uuid)`,
      [orgId, fromUserId, toUserId],
    );

    const { rows } = await client.query<{ task_id: string }>(
      `UPDATE task_assignees ta
          SET user_id = $3::uuid,
              status = 'pending',
              assigned_by = $4::uuid,
              assigned_at = now(),
              responded_at = NULL,
              decline_reason = NULL
        WHERE ta.org_id = $1 AND ta.user_id = $2
          AND ta.status IN ('pending', 'accepted')
          AND EXISTS (SELECT 1 FROM tasks t
                       WHERE t.id = ta.task_id AND t.status = 'open')
        RETURNING ta.task_id`,
      [orgId, fromUserId, toUserId, actorUserId],
    );
    return rows.length;
  }

  /**
   * Open call-backs, through `CallbacksService.reassign` one at a time.
   *
   * A set-based UPDATE would have been three lines and wrong. That method does
   * three things a bare column write cannot: it cancels the reminders already
   * planned for the person who left and re-plans them for whoever now owns the
   * call-back (otherwise the popup fires on a phone nobody is holding), it
   * leaves `original_user_id` alone so the trail of who promised the customer
   * a call survives, and it audits the move as a reassignment rather than as a
   * mystery edit.
   *
   * A loop is fine at this size - a person's open call-back list is tens of
   * rows, not thousands, because a call-back that is never made eventually
   * escalates or closes.
   */
  private async moveCallbacks(
    client: DbClient,
    orgId: string,
    req: PrincipalRequest,
    input: {
      fromUserId: string;
      fromTelecallerId: string | null;
      toUserId: string;
      toTelecallerId: string | null;
      who: string;
    },
  ): Promise<number> {
    const { rows } = await client.query<CallbackRow>(
      `SELECT id, lead_id, contact_id, contact_name, contact_phone_hash, contact_phone_last3,
              number_key, requested_text, notes, status, type, committed, due_at,
              window_start, window_end, attempts, max_attempts, last_attempt_at,
              assigned_user_id, assigned_telecaller_id, original_user_id, original_telecaller_id
         FROM callbacks
        WHERE org_id = $1
          AND status IN (${OPEN_CALLBACKS})
          AND (assigned_user_id = $2 OR assigned_telecaller_id = $3::uuid)
        ORDER BY due_at
        FOR UPDATE`,
      [orgId, input.fromUserId, input.fromTelecallerId],
    );

    for (const current of rows) {
      await this.callbacks.reassign(client, orgId, req, {
        id: current.id,
        current,
        assignedUserId: input.toUserId,
        assignedTelecallerId: input.toTelecallerId,
        reason: `${input.who} left the workspace - handed over during offboarding`,
      });
    }
    return rows.length;
  }

  /**
   * One notification, with the totals (0198's `work_handover`).
   *
   * Not one per record. The alternative - letting each mover notify the way a
   * single reassignment does - puts a hundred and twelve rows in somebody's
   * bell from one click, and a bell somebody clears without reading is a bell
   * that has stopped working for every other kind too.
   */
  private async tellRecipient(
    client: DbClient,
    orgId: string,
    recipientUserId: string,
    manifest: OffboardManifest,
    moved: OffboardWork,
  ): Promise<void> {
    const parts: string[] = [];
    const add = (n: number, one: string, many: string) => {
      if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
    };
    add(moved.leads, "lead", "leads");
    add(moved.dealsOwned + moved.dealsDesk, "deal", "deals");
    add(moved.callbacks, "call-back", "call-backs");
    add(moved.tasks + moved.taskSeats, "task", "tasks");
    add(moved.contacts, "contact", "contacts");
    add(moved.accounts, "account", "accounts");
    add(moved.conversations, "conversation", "conversations");
    if (parts.length === 0) return;

    const who = manifest.member.name ?? manifest.member.email;
    const list =
      parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

    await client.query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path)
       VALUES ($1, $2, 'work_handover', $3, $4, '/owner/leads')`,
      [
        orgId,
        recipientUserId,
        `${who}'s work is now yours`,
        `${list} moved to you. Tasks are waiting for you to accept or decline them.`,
      ],
    );
  }

  private async loadMember(
    client: DbClient,
    orgId: string,
    userId: string,
  ): Promise<OffboardMember> {
    const {
      rows: [row],
    } = await client.query<{
      user_id: string;
      email: string;
      name: string | null;
      owner_role: string | null;
      status: string;
      telecaller_id: string | null;
      telecaller_name: string | null;
      telecaller_status: string | null;
    }>(
      `SELECT m.user_id, u.email, u.name, m.owner_role, m.status,
              t.id AS telecaller_id, t.display_name AS telecaller_name,
              t.status AS telecaller_status
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN telecallers t ON t.org_id = m.org_id AND t.user_id = m.user_id
        WHERE m.org_id = $1 AND m.user_id = $2
        ORDER BY (m.scope_type = 'org') DESC, m.id
        LIMIT 1`,
      [orgId, userId],
    );
    if (!row) throw new NotFoundException("member not found in this org");
    return {
      userId: row.user_id,
      email: row.email,
      name: row.name,
      ownerRole: row.owner_role,
      status: row.status,
      telecallerId: row.telecaller_id,
      telecallerName: row.telecaller_name,
      telecallerStatus: row.telecaller_status,
    };
  }

  /**
   * Who is receiving the work.
   *
   * Must be an ACTIVE member of this org: handing a departing rep's desk to a
   * colleague who is themselves suspended would move the problem one row down
   * the roster and look like it worked.
   */
  private async loadRecipient(
    client: DbClient,
    orgId: string,
    recipientId: string,
    departingId: string,
  ): Promise<{ userId: string; email: string; telecallerId: string | null }> {
    if (recipientId === departingId) {
      throw new BadRequestException("the work cannot be handed to the person leaving");
    }
    const {
      rows: [row],
    } = await client.query<{ user_id: string; email: string; telecaller_id: string | null }>(
      `SELECT m.user_id, u.email, t.id AS telecaller_id
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN telecallers t
                ON t.org_id = m.org_id AND t.user_id = m.user_id AND t.status = 'active'
        WHERE m.org_id = $1 AND m.user_id = $2 AND m.status = 'active'
        ORDER BY (m.scope_type = 'org') DESC, m.id
        LIMIT 1`,
      [orgId, recipientId],
    );
    if (!row) {
      throw new BadRequestException(
        "whoever receives the work has to be an active member of this workspace",
      );
    }
    return { userId: row.user_id, email: row.email, telecallerId: row.telecaller_id };
  }

  private async liveDevices(
    client: DbClient,
    orgId: string,
    telecallerId: string,
  ): Promise<OffboardDevice[]> {
    const { rows } = await client.query<{
      id: string;
      label: string | null;
      status: string;
      calls: number;
    }>(
      `SELECT d.id, d.label, d.status,
              (SELECT count(*)::int FROM calls c WHERE c.device_id = d.id) AS calls
         FROM devices d
        WHERE d.org_id = $1 AND d.telecaller_id = $2 AND d.removed_at IS NULL
        ORDER BY d.label NULLS LAST, d.id`,
      [orgId, telecallerId],
    );
    return rows.map((r) => ({ ...r, calls: Number(r.calls) }));
  }

  private async routingRules(
    client: DbClient,
    orgId: string,
    telecallerId: string,
  ): Promise<OffboardRule[]> {
    const { rows } = await client.query<{
      id: string;
      name: string;
      status: string;
      others_active: string;
    }>(
      `SELECT r.id, r.name, r.status,
              (SELECT count(*)
                 FROM lead_routing_targets t2
                 JOIN telecallers tc2 ON tc2.id = t2.telecaller_id
                WHERE t2.rule_id = r.id
                  AND tc2.status = 'active'
                  AND tc2.id <> $2::uuid) AS others_active
         FROM lead_routing_rules r
         JOIN lead_routing_targets t ON t.rule_id = r.id
        WHERE r.org_id = $1 AND t.telecaller_id = $2::uuid AND r.deleted_at IS NULL
        ORDER BY r.name`,
      [orgId, telecallerId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      othersActive: Number(r.others_active),
    }));
  }
}
