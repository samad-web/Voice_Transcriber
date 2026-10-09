"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { X } from "lucide-react";
import {
  Button,
  ErrorBanner,
  FormField,
  Input,
  Select,
  StatusChip,
  useToast,
} from "@aura/ui";
import {
  ASSIGNMENT_TYPE_LABELS,
  HOLDER_PRESENCE_LABELS,
  ORG_CHANGE_ACTION_LABELS,
  ORG_CHANGE_ENTITY_LABELS,
  POSITION_STATUS_LABELS,
  SUGGESTED_AUTHORITY_ACTIONS,
  initialsOf,
} from "@aura/shared";
import { InlineListSkeleton } from "@/components/skeletons";
import { TEXTAREA_CLASS } from "../lead-drawer";
import { ContractEditor } from "./contract-editor";
import {
  assignPositionAction,
  fetchPositionAction,
  setAuthorityAction,
  setResponsibilitiesAction,
  setSkillsAction,
  unassignPositionAction,
  updatePositionAction,
} from "./actions";
import type {
  AssignableMember,
  ChartAbilities,
  ChangeRow,
  ProfilePayload,
} from "./types";

/**
 * §6's position profile - the drawer every node opens
 * (Build docs/org-chart-build-plan.md §6, milestone M3).
 *
 * ── THE TABS, AND THE TWO THAT ARE NOT ALWAYS THERE ────────────────────────
 *
 * Overview, Role and responsibilities, History - always. Contract, only for a
 * reader holding `employment_contract:view`. Performance and finance, only
 * when those modules are present.
 *
 * The restricted tabs are not rendered-and-disabled, they are ABSENT. A greyed
 * "Contract" tab tells a telecaller that a contract exists and that somebody
 * decided they may not see it, which is information they were not given - and
 * §7's rule is enforced at the API anyway, so a visible-but-dead tab would be
 * a promise the console cannot keep either way.
 *
 * ── WHY THE PAYLOAD IS FETCHED HERE AND NOT PASSED IN ──────────────────────
 *
 * §12: "details fetched lazily on node open". The chart payload deliberately
 * carries no purpose text, no responsibilities and no authority rows - partly
 * for the 300 KB budget, mostly because every persona receives it and the
 * safest payload is one with nothing sensitive in it. So opening a node is a
 * request, and the drawer owns its own loading and error states.
 */

type Tab = "overview" | "role" | "contract" | "history";

export interface PositionDrawerProps {
  positionId: string;
  asOf: string;
  /** §5.2: the past is read-only, and the banner says so. */
  readOnly: boolean;
  abilities: ChartAbilities;
  members: AssignableMember[];
  onClose: () => void;
  onJumpTo: (positionId: string) => void;
  /** Re-reads the chart after a write that changes it. */
  onChanged: () => void;
  /** §6.5's timeline, already fetched for the whole org by the page. */
  changes: ChangeRow[];
}

export function PositionDrawer({
  positionId,
  asOf,
  readOnly,
  abilities,
  members,
  onClose,
  onJumpTo,
  onChanged,
  changes,
}: PositionDrawerProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [profile, setProfile] = useState<ProfilePayload | null>(null);
  /** The read failing - the drawer has nothing to show. */
  const [failed, setFailed] = useState<string | null>(null);
  /**
   * A WRITE failing - the drawer still has its content, and the refusal sits
   * above it. Separate state from `failed` on purpose: replacing the whole
   * drawer with "Head of Sales reports to Sales Rep" would throw away the
   * reader's place and the form they were filling in.
   */
  const [refused, setRefused] = useState<string | null>(null);
  const showToast = useToast();
  const notify: Notify = useMemo(
    () => ({
      toast: (message: string) => {
        setRefused(null);
        showToast(message);
      },
      fail: setRefused,
    }),
    [showToast],
  );

  useEffect(() => {
    let live = true;
    setProfile(null);
    setFailed(null);
    void fetchPositionAction(positionId, asOf).then((result) => {
      if (!live) return;
      if (result.error) setFailed(result.error);
      else setProfile(result.data ?? null);
    });
    return () => {
      live = false;
    };
  }, [positionId, asOf]);

  // Escape closes, like every other drawer in the console.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reload = async () => {
    const result = await fetchPositionAction(positionId, asOf);
    if (!result.error) setProfile(result.data ?? null);
    onChanged();
  };

  const ownChanges = useMemo(
    () =>
      changes.filter(
        (change) =>
          change.entityId === positionId ||
          (change.after as { positionId?: string } | null)?.positionId === positionId ||
          (change.before as { positionId?: string } | null)?.positionId === positionId,
      ),
    [changes, positionId],
  );

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "role", label: "Role" },
    ...(abilities.canSeeContracts ? ([{ key: "contract", label: "Contract" }] as const) : []),
    { key: "history", label: "History" },
  ];

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={profile ? `${profile.position.title} details` : "Position details"}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-border bg-surface shadow-xl"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          {profile ? (
            <>
              <h2 className="truncate text-base font-semibold text-text">
                {profile.position.title}
              </h2>
              <p className="mt-0.5 truncate text-xs text-text-muted">
                {[profile.position.departmentName, profile.position.teamName]
                  .filter(Boolean)
                  .join(" · ") || "No department"}
              </p>
            </>
          ) : (
            <h2 className="text-base font-semibold text-text">Position</h2>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
        >
          <X className="size-4" />
        </button>
      </header>

      <nav className="flex gap-1 border-b border-border px-3" aria-label="Position details">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            aria-current={tab === entry.key ? "page" : undefined}
            className={
              tab === entry.key
                ? "border-b-2 border-accent px-3 py-2 text-sm font-medium text-text"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-text-muted transition-colors hover:text-text"
            }
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {refused ? (
          <div className="mb-4">
            <ErrorBanner>{refused}</ErrorBanner>
          </div>
        ) : null}
        {failed ? (
          <ErrorBanner>{failed}</ErrorBanner>
        ) : !profile ? (
          <InlineListSkeleton rows={5} />
        ) : tab === "overview" ? (
          <Overview
            profile={profile}
            readOnly={readOnly}
            abilities={abilities}
            members={members}
            onJumpTo={onJumpTo}
            onChanged={reload}
            notify={notify}
          />
        ) : tab === "role" ? (
          <RoleTab
            profile={profile}
            readOnly={readOnly}
            abilities={abilities}
            onChanged={reload}
            notify={notify}
          />
        ) : tab === "contract" ? (
          <ContractEditor
            profile={profile}
            canEdit={abilities.canEditContracts}
            readOnly={readOnly}
          />
        ) : (
          <HistoryTab changes={ownChanges} />
        )}
      </div>
    </aside>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// §6.1 Overview
// ───────────────────────────────────────────────────────────────────────────

/**
 * How a tab reports an outcome.
 *
 * Two functions rather than one with a kind, because the console treats the
 * two differently and always has: a success is a toast that clears itself, a
 * failure is a banner that stays until it is read. `useToast` is
 * `(message) => void` by design - the kit has no error toast - and the
 * failure path is the drawer's own `<ErrorBanner>`, which is where a refusal
 * like "Head of Sales reports to Sales Rep" needs to sit while somebody reads
 * it twice.
 */
interface Notify {
  toast: (message: string) => void;
  fail: (message: string) => void;
}

function Overview({
  profile,
  readOnly,
  abilities,
  members,
  onJumpTo,
  onChanged,
  notify,
}: {
  profile: ProfilePayload;
  readOnly: boolean;
  abilities: ChartAbilities;
  members: AssignableMember[];
  onJumpTo: (id: string) => void;
  onChanged: () => Promise<void>;
  notify: Notify;
}) {
  const [pending, start] = useTransition();
  const [assigning, setAssigning] = useState(false);
  const [userId, setUserId] = useState("");
  const [assignmentType, setAssignmentType] = useState<"primary" | "acting">("primary");
  const [title, setTitle] = useState(profile.position.title);
  const editable = abilities.canEdit && !readOnly;

  const assign = () =>
    start(async () => {
      if (!userId) {
        notify.fail("Choose somebody first.");
        return;
      }
      const result = await assignPositionAction(profile.position.id, { userId, assignmentType });
      if (result.error) {
        notify.fail(result.error);
        return;
      }
      setAssigning(false);
      setUserId("");
      notify.toast("Position assigned.");
      await onChanged();
    });

  const unassign = () =>
    start(async () => {
      const result = await unassignPositionAction(profile.position.id, {});
      if (result.error) {
        notify.fail(result.error);
        return;
      }
      notify.toast("The position is now vacant.");
      await onChanged();
    });

  const rename = () =>
    start(async () => {
      if (title.trim() === profile.position.title) return;
      const result = await updatePositionAction(profile.position.id, { title: title.trim() });
      if (result.error) {
        notify.fail(result.error);
        return;
      }
      notify.toast("Position renamed.");
      await onChanged();
    });

  const freeze = () =>
    start(async () => {
      const next = profile.position.storedStatus === "frozen" ? "filled" : "frozen";
      const result = await updatePositionAction(profile.position.id, { status: next });
      if (result.error) {
        notify.fail(result.error);
        return;
      }
      notify.toast(
        next === "frozen"
          ? "Frozen. It will not be counted as a vacancy to fill."
          : "Unfrozen.",
      );
      await onChanged();
    });

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className="grid size-12 shrink-0 place-items-center rounded-full bg-label-steel text-sm font-semibold text-label-steel-text"
        >
          {profile.holder ? initialsOf(profile.holder.name ?? profile.holder.email) : "+"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">
            {profile.holder?.name ?? profile.holder?.email ?? "Nobody holds this position"}
          </p>
          {profile.holder ? (
            <p className="truncate text-xs text-text-muted">{profile.holder.email}</p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusChip tone={profile.position.status === "vacant" ? "outline" : "muted"}>
              {POSITION_STATUS_LABELS[profile.position.status]}
            </StatusChip>
            {profile.holder ? (
              <StatusChip tone="muted">
                {HOLDER_PRESENCE_LABELS[profile.holder.presence]}
              </StatusChip>
            ) : null}
          </div>
        </div>
      </div>

      {profile.holder ? (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-text-muted">In this position since</dt>
            <dd className="text-text">{profile.holder.startDate}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">Time in the position</dt>
            {/*
              §6.1 asks for "tenure". This is tenure IN THE SEAT, from the
              assignment's start date - not time with the business, which is
              the contract's start date and sits on the Contract tab. Somebody
              promoted last month has one month here and five years there, and
              conflating them is how a chart makes a long-serving person look
              new.
            */}
            <dd className="text-text">
              {profile.holder.tenureMonths === 0
                ? "Under a month"
                : profile.holder.tenureMonths < 12
                  ? `${profile.holder.tenureMonths} month${profile.holder.tenureMonths === 1 ? "" : "s"}`
                  : `${Math.floor(profile.holder.tenureMonths / 12)} year${Math.floor(profile.holder.tenureMonths / 12) === 1 ? "" : "s"}${profile.holder.tenureMonths % 12 ? ` ${profile.holder.tenureMonths % 12}m` : ""}`}
            </dd>
          </div>
        </dl>
      ) : null}

      {profile.acting.length > 0 ? (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
            {ASSIGNMENT_TYPE_LABELS.acting}
          </h3>
          <ul className="mt-1.5 space-y-1 text-sm text-text">
            {profile.acting.map((person) => (
              <li key={person.assignmentId}>
                {person.name ?? person.email}
                <span className="text-text-muted">
                  {" "}
                  · from {person.startDate}
                  {person.endDate ? ` to ${person.endDate}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
          Reports to
        </h3>
        {profile.reportsTo ? (
          <button
            type="button"
            onClick={() => onJumpTo(profile.reportsTo!.id)}
            className="text-sm text-accent-text underline-offset-2 hover:underline"
          >
            {profile.reportsTo.title}
            {profile.reportsTo.holder ? ` · ${profile.reportsTo.holder}` : " · vacant"}
          </button>
        ) : (
          <p className="text-sm text-text-muted">
            Nobody. This is the top of the chart.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
          Direct reports ({profile.directReports.length})
        </h3>
        {profile.directReports.length === 0 ? (
          <p className="text-sm text-text-muted">No positions report to this one.</p>
        ) : (
          <ul className="space-y-1">
            {profile.directReports.map((report) => (
              <li key={report.id}>
                <button
                  type="button"
                  onClick={() => onJumpTo(report.id)}
                  className="text-sm text-accent-text underline-offset-2 hover:underline"
                >
                  {report.title}
                  <span className="text-text-muted">
                    {report.holder ? ` · ${report.holder}` : " · vacant"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {profile.dottedLines.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Also works with
          </h3>
          <ul className="space-y-1 text-sm">
            {profile.dottedLines.map((line) => (
              <li key={`${line.direction}-${line.id}`}>
                <button
                  type="button"
                  onClick={() => onJumpTo(line.id)}
                  className="text-accent-text underline-offset-2 hover:underline"
                >
                  {line.title}
                </button>
                <span className="text-text-muted">
                  {line.direction === "to" ? " (reports to)" : " (reports here)"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {editable ? (
        <section className="space-y-3 border-t border-border pt-4">
          <FormField label="Position title" name="org-chart-title">
            <div className="flex gap-2">
              <Input
                id="org-chart-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
              />
              <Button
                variant="secondary"
                onClick={rename}
                disabled={pending || title.trim() === profile.position.title || !title.trim()}
              >
                Rename
              </Button>
            </div>
          </FormField>

          {profile.holder ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setAssigning(true)} disabled={pending}>
                Replace the holder
              </Button>
              <Button variant="secondary" onClick={unassign} disabled={pending}>
                Make vacant
              </Button>
            </div>
          ) : (
            <Button onClick={() => setAssigning(true)} disabled={pending}>
              Assign somebody
            </Button>
          )}

          {assigning ? (
            <div className="space-y-2 rounded-md border border-border bg-bg-subtle p-3">
              <FormField label="Who" name="org-chart-assignee">
                <Select
                  id="org-chart-assignee"
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                >
                  <option value="">Choose a person…</option>
                  {members.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.name ?? member.email}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="As" name="org-chart-assignment-type">
                <Select
                  id="org-chart-assignment-type"
                  value={assignmentType}
                  onChange={(event) =>
                    setAssignmentType(event.target.value as "primary" | "acting")
                  }
                >
                  <option value="primary">{ASSIGNMENT_TYPE_LABELS.primary}</option>
                  <option value="acting">{ASSIGNMENT_TYPE_LABELS.acting}</option>
                </Select>
              </FormField>
              {/*
                The one thing worth saying out loud at the moment of the
                choice: a replacement does not erase the person who was there.
                §4.3's never-overwrite-history is invisible in the UI otherwise,
                and somebody hesitating over this button is usually worried
                about exactly that.
              */}
              <p className="text-xs text-text-muted">
                {assignmentType === "primary" && profile.holder
                  ? "The current holder's time in this position is closed off, not deleted - the history keeps it."
                  : assignmentType === "acting"
                    ? "An acting holder sits alongside the current one rather than replacing them."
                    : "Their default targets for this position, if any, are set up for the current month."}
              </p>
              <div className="flex gap-2">
                <Button onClick={assign} disabled={pending || !userId}>
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setAssigning(false)} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          <div className="border-t border-border pt-3">
            <Button variant="ghost" onClick={freeze} disabled={pending}>
              {profile.position.storedStatus === "frozen"
                ? "Unfreeze this position"
                : "Freeze this position"}
            </Button>
            <p className="mt-1 text-xs text-text-muted">
              A frozen position is parked on purpose: it is not counted as a vacancy to fill and
              never raises the empty-too-long alert.
            </p>
          </div>
        </section>
      ) : readOnly ? (
        <p className="border-t border-border pt-4 text-xs text-text-muted">
          You are looking at the chart as it stood on {profile.asOf}. Switch back to today to make
          changes.
        </p>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// §6.2 Role and responsibilities
// ───────────────────────────────────────────────────────────────────────────

function RoleTab({
  profile,
  readOnly,
  abilities,
  onChanged,
  notify,
}: {
  profile: ProfilePayload;
  readOnly: boolean;
  abilities: ChartAbilities;
  onChanged: () => Promise<void>;
  notify: Notify;
}) {
  const [pending, start] = useTransition();
  const [purpose, setPurpose] = useState(profile.position.purpose ?? "");
  const [items, setItems] = useState(profile.responsibilities.map((r) => r.text));
  const [authority, setAuthority] = useState(
    profile.authority.map((a) => ({
      action: a.action,
      limitNum: a.limitNum === null ? "" : String(a.limitNum),
      currency: a.currency ?? "INR",
      requiresApprovalFromPositionId: a.requiresApprovalFromPositionId ?? "",
    })),
  );
  const [skills, setSkills] = useState(profile.skills.map((s) => s.skill));

  /**
   * §14's manager-edit setting reaches the RESPONSIBILITIES list only.
   *
   * Not the authority table and not the purpose. §7 is specific - "optionally
   * edit responsibilities of direct reports" - and the authority table is
   * where spending limits live, which is not something a manager should be
   * able to widen for their own team. The API enforces the same split: the
   * `/as-manager` route only accepts a responsibilities body.
   */
  const canEditAll = abilities.canEdit && !readOnly;
  const canEditResponsibilities = canEditAll || (abilities.managerEditsReports && !readOnly);

  const savePurpose = () =>
    start(async () => {
      const result = await updatePositionAction(profile.position.id, {
        purpose: purpose.trim() || null,
      });
      if (result.error) notify.fail(result.error);
      else {
        notify.toast("Saved.");
        await onChanged();
      }
    });

  const saveResponsibilities = () =>
    start(async () => {
      const result = await setResponsibilitiesAction(profile.position.id, {
        items: items.map((text) => ({ text })).filter((i) => i.text.trim()),
      });
      if (result.error) notify.fail(result.error);
      else {
        notify.toast("Responsibilities saved.");
        await onChanged();
      }
    });

  const saveAuthority = () =>
    start(async () => {
      const result = await setAuthorityAction(profile.position.id, {
        items: authority
          .filter((row) => row.action.trim())
          .map((row) => ({
            action: row.action.trim(),
            limitNum: row.limitNum === "" ? null : Number(row.limitNum),
            currency: row.limitNum === "" ? null : row.currency,
            requiresApprovalFromPositionId: row.requiresApprovalFromPositionId || null,
          })),
      });
      if (result.error) notify.fail(result.error);
      else {
        notify.toast("Decision authority saved.");
        await onChanged();
      }
    });

  const saveSkills = () =>
    start(async () => {
      const result = await setSkillsAction(profile.position.id, {
        items: skills.filter((s) => s.trim()).map((skill) => ({ skill: skill.trim() })),
      });
      if (result.error) notify.fail(result.error);
      else {
        notify.toast("Skills saved.");
        await onChanged();
      }
    });

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text">What this position is for</h3>
        {canEditAll ? (
          <>
            <textarea
              className={TEXTAREA_CLASS}
              rows={3}
              value={purpose}
              maxLength={2000}
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="Two or three lines on why this position exists."
            />
            <Button
              variant="secondary"
              onClick={savePurpose}
              disabled={pending || purpose === (profile.position.purpose ?? "")}
            >
              Save
            </Button>
          </>
        ) : (
          <p className="text-sm text-text">
            {profile.position.purpose ?? (
              <span className="text-text-muted">Nobody has written this down yet.</span>
            )}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text">Key responsibilities</h3>
        {canEditResponsibilities ? (
          <>
            <ol className="space-y-2">
              {items.map((text, index) => (
                <li key={index} className="flex gap-2">
                  <span className="pt-2 text-xs text-text-subtle">{index + 1}</span>
                  <Input
                    value={text}
                    maxLength={500}
                    onChange={(event) =>
                      setItems(items.map((v, i) => (i === index ? event.target.value : v)))
                    }
                  />
                  {/* Reordering is drag-free on purpose: two arrows are usable
                      by keyboard, which §5.4 asks for, and a list of six items
                      does not need a drag affordance. */}
                  <button
                    type="button"
                    aria-label={`Move responsibility ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => {
                      const next = [...items];
                      [next[index - 1], next[index]] = [next[index], next[index - 1]];
                      setItems(next);
                    }}
                    className="rounded px-1.5 text-text-muted transition-colors hover:bg-surface-hover disabled:opacity-40"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove responsibility ${index + 1}`}
                    onClick={() => setItems(items.filter((_, i) => i !== index))}
                    className="rounded px-1.5 text-text-muted transition-colors hover:bg-surface-hover"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setItems([...items, ""])} disabled={pending}>
                Add one
              </Button>
              <Button variant="secondary" onClick={saveResponsibilities} disabled={pending}>
                Save the list
              </Button>
            </div>
          </>
        ) : profile.responsibilities.length === 0 ? (
          <p className="text-sm text-text-muted">Nothing listed yet.</p>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-sm text-text">
            {profile.responsibilities.map((item) => (
              <li key={item.id}>{item.text}</li>
            ))}
          </ol>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text">What this position can approve</h3>
        {profile.authority.length === 0 && !canEditAll ? (
          <p className="text-sm text-text-muted">No approval limits are recorded.</p>
        ) : null}
        {!canEditAll && profile.authority.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {profile.authority.map((row) => (
              <li key={row.id} className="text-text">
                <span className="font-medium">{labelForAction(row.action)}</span>
                {row.limitNum !== null ? (
                  <>
                    {" "}
                    up to {row.currency} {row.limitNum.toLocaleString()}
                  </>
                ) : row.limitPercent !== null ? (
                  <> up to {row.limitPercent}%</>
                ) : (
                  <> with no limit</>
                )}
                {row.approverTitle ? (
                  <span className="text-text-muted"> · above that, {row.approverTitle}</span>
                ) : row.limitNum !== null || row.limitPercent !== null ? (
                  <span className="text-text-muted"> · above that, their manager</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canEditAll ? (
          <>
            <ul className="space-y-2">
              {authority.map((row, index) => (
                <li key={index} className="grid grid-cols-[1fr_auto_auto] gap-2">
                  <Select
                    aria-label="What can be approved"
                    value={row.action}
                    onChange={(event) =>
                      setAuthority(
                        authority.map((v, i) =>
                          i === index ? { ...v, action: event.target.value } : v,
                        ),
                      )
                    }
                  >
                    <option value="">Choose…</option>
                    {SUGGESTED_AUTHORITY_ACTIONS.map((suggestion) => (
                      <option key={suggestion.key} value={suggestion.key}>
                        {suggestion.label}
                      </option>
                    ))}
                    {/* A key this tenant already uses that is not in the
                        suggestion list - the set is open (see
                        AuthorityActionKey), so an existing row must not vanish
                        from its own picker. */}
                    {row.action &&
                    !SUGGESTED_AUTHORITY_ACTIONS.some((s) => s.key === row.action) ? (
                      <option value={row.action}>{labelForAction(row.action)}</option>
                    ) : null}
                  </Select>
                  <Input
                    aria-label="Limit"
                    inputMode="decimal"
                    placeholder="No limit"
                    className="w-28"
                    value={row.limitNum}
                    onChange={(event) =>
                      setAuthority(
                        authority.map((v, i) =>
                          i === index ? { ...v, limitNum: event.target.value } : v,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-label="Remove this limit"
                    onClick={() => setAuthority(authority.filter((_, i) => i !== index))}
                    className="rounded px-1.5 text-text-muted transition-colors hover:bg-surface-hover"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() =>
                  setAuthority([
                    ...authority,
                    { action: "", limitNum: "", currency: "INR", requiresApprovalFromPositionId: "" },
                  ])
                }
                disabled={pending}
              >
                Add a limit
              </Button>
              <Button variant="secondary" onClick={saveAuthority} disabled={pending}>
                Save
              </Button>
            </div>
            <p className="text-xs text-text-muted">
              Leave the limit blank for &ldquo;no limit&rdquo;. Anything above a limit goes to this
              position&rsquo;s manager unless somebody else is named.
            </p>
          </>
        ) : null}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text">Escalates to</h3>
        {/*
          §6.2: "who they escalate to and for what, derived from the reporting
          line and authority table". DERIVED, not stored - which is why it is
          rendered here from the two things above rather than being a field
          somebody fills in and then forgets to change after a reorganization.
        */}
        {profile.reportsTo ? (
          <p className="text-sm text-text">
            {profile.reportsTo.title}
            {profile.reportsTo.holder ? ` (${profile.reportsTo.holder})` : " (vacant)"}
            {profile.authority.some((a) => a.approverTitle) ? (
              <span className="text-text-muted">
                {" "}
                · except where a limit above names somebody else
              </span>
            ) : null}
          </p>
        ) : (
          <p className="text-sm text-text-muted">
            Nowhere - this is the top of the chart.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-text">Skills this position needs</h3>
        {canEditAll ? (
          <>
            <div className="flex flex-wrap gap-2">
              {skills.map((skill, index) => (
                <span key={index} className="flex items-center gap-1">
                  <Input
                    className="w-40"
                    value={skill}
                    maxLength={120}
                    onChange={(event) =>
                      setSkills(skills.map((v, i) => (i === index ? event.target.value : v)))
                    }
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${skill || "this skill"}`}
                    onClick={() => setSkills(skills.filter((_, i) => i !== index))}
                    className="rounded px-1 text-text-muted transition-colors hover:bg-surface-hover"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setSkills([...skills, ""])} disabled={pending}>
                Add a skill
              </Button>
              <Button variant="secondary" onClick={saveSkills} disabled={pending}>
                Save
              </Button>
            </div>
          </>
        ) : profile.skills.length === 0 ? (
          <p className="text-sm text-text-muted">None listed.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {profile.skills.map((skill) => (
              <li
                key={skill.id}
                className="rounded-full border border-border px-2 py-0.5 text-xs text-text"
              >
                {skill.skill}
              </li>
            ))}
          </ul>
        )}
      </section>

      {profile.kpiDefaults.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-text">Default targets for this position</h3>
          <ul className="space-y-1 text-sm text-text">
            {profile.kpiDefaults.map((kpi) => (
              <li key={kpi.metric}>
                {kpi.metric.replace(/_/g, " ")} · {kpi.targetValue.toLocaleString()}
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">
            Somebody assigned to this position gets these as their own targets for the current
            month, unless they already have one.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function labelForAction(action: string): string {
  const known = SUGGESTED_AUTHORITY_ACTIONS.find((s) => s.key === action);
  if (known) return known.label;
  // An open-set key this tenant invented - shown as words rather than a slug.
  return action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// ───────────────────────────────────────────────────────────────────────────
// §6.5 History
// ───────────────────────────────────────────────────────────────────────────

function HistoryTab({ changes }: { changes: ChangeRow[] }) {
  if (changes.length === 0) {
    return <p className="text-sm text-text-muted">Nothing has changed here yet.</p>;
  }
  return (
    <ol className="space-y-3">
      {changes.map((change) => (
        <li key={change.id} className="border-b border-border pb-3 last:border-0">
          <p className="text-sm text-text">
            {ORG_CHANGE_ACTION_LABELS[change.action as keyof typeof ORG_CHANGE_ACTION_LABELS] ??
              change.action}{" "}
            ·{" "}
            {ORG_CHANGE_ENTITY_LABELS[change.entity as keyof typeof ORG_CHANGE_ENTITY_LABELS] ??
              change.entity}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            {/*
              The EFFECTIVE date leads, and the date it was recorded follows in
              brackets. §4.3's whole point is that a reorganization decided on
              12 March and effective 1 April has two dates, and the one that
              matters to a reader of a timeline is the second.
            */}
            {change.effectiveDate ? `Effective ${change.effectiveDate}` : "Took effect at once"}
            {" · "}
            {change.actorName ?? change.actorId}
            {" · recorded "}
            {change.at.slice(0, 10)}
          </p>
          {change.reason ? (
            <p className="mt-1 text-xs italic text-text-muted">&ldquo;{change.reason}&rdquo;</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
