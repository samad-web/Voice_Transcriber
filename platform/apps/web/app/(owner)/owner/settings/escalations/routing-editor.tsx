"use client";

import { useState, useTransition } from "react";
import {
  ESCALATION_POOL_LABEL,
  OWNER_ROLE_LABELS,
  OwnerRole,
  type CallEscalationRoutingInput,
  type CallEscalationSettingsView,
} from "@aura/shared";
import { Card, EmptyState, ErrorBanner, Select, useToast } from "@aura/ui";
import { useServerState } from "@/lib/use-server-state";
import { Toggle } from "../attendance/toggle";
import { updateEscalationRoutingAction } from "./actions";

/** The select's value for "the default" - `null` on the wire. */
const DEFAULT = "__default__";

type Settings = CallEscalationSettingsView;
type Member = Settings["members"][number];
type Telecaller = Settings["telecallers"][number];

function roleLabel(role: string): string {
  const parsed = OwnerRole.safeParse(role);
  return parsed.success ? OWNER_ROLE_LABELS[parsed.data] : role;
}

/** A recipient as the select offers it: "Priya (Manager)", "Arun (Senior telecaller)". */
function recipientLabel(m: Member): string {
  const role = roleLabel(m.ownerRole);
  return m.senior && (m.ownerRole === "telecaller" || m.ownerRole === "sales")
    ? `${m.name} (Senior ${role.toLowerCase()})`
    : `${m.name} (${role})`;
}

function defaultLabel(t: Telecaller): string {
  return t.reportsToName
    ? `Default - ${t.reportsToName} (their manager)`
    : `Default - ${ESCALATION_POOL_LABEL}`;
}

/**
 * Who receives escalations (0151, Build docs/38, "Who receives it").
 *
 * Two lists, one save path. SENIORS: owners and managers always receive; a
 * telecaller or a rep with a console login can be marked a senior so they can
 * too. ESCALATES TO: each telecaller's own recipient, picked from everybody
 * who can receive - with the default spelled out, because "default" alone
 * says nothing about where a call will actually go.
 *
 * Every change is one `PUT routing` carrying only the row that changed, and
 * the page is re-read afterwards: un-marking a senior also clears any
 * telecaller pointed at them, which moves their "Reaches now" too.
 */
export function EscalationRouting({ initial }: { initial: Settings }) {
  const toast = useToast();
  const [settings, setSettings] = useServerState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canEdit = settings.canEditRouting;
  const eligible = settings.members.filter((m) => m.ownerRole === "telecaller" || m.ownerRole === "sales");
  const recipients = settings.members.filter((m) => m.canReceive);
  const nameOf = (membershipId: string | null) =>
    settings.members.find((m) => m.membershipId === membershipId)?.name ?? null;

  const save = (input: CallEscalationRoutingInput, optimistic: (s: Settings) => Settings, done: string) => {
    setError(null);
    startTransition(async () => {
      const result = await updateEscalationRoutingAction(input);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSettings((s) => result.settings ?? optimistic(s));
      toast(done);
    });
  };

  const setSenior = (m: Member, senior: boolean) =>
    save(
      { seniors: [{ membershipId: m.membershipId, senior }] },
      (s) => ({
        ...s,
        members: s.members.map((x) =>
          x.membershipId === m.membershipId ? { ...x, senior, canReceive: senior } : x,
        ),
      }),
      senior ? `${m.name} can now receive escalations` : `${m.name} no longer receives escalations`,
    );

  const setRecipient = (t: Telecaller, value: string) => {
    const escalateToMembershipId = value === DEFAULT ? null : value;
    const to = escalateToMembershipId ? nameOf(escalateToMembershipId) : null;
    save(
      { telecallers: [{ telecallerId: t.telecallerId, escalateToMembershipId }] },
      (s) => ({
        ...s,
        telecallers: s.telecallers.map((x) =>
          x.telecallerId === t.telecallerId
            ? { ...x, escalateToMembershipId, effectiveRecipientName: to ?? x.reportsToName ?? null }
            : x,
        ),
      }),
      to ? `${t.name} now escalates to ${to}` : `${t.name} now uses the default`,
    );
  };

  return (
    <div className="space-y-6">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <section aria-labelledby="esc-seniors" className="space-y-3">
        <div>
          <h2 id="esc-seniors" className="text-sm font-semibold text-text">
            Seniors
          </h2>
          <p className="text-xs text-text-muted">
            Owners and managers can always receive escalations. Turn this on for a telecaller or a sales
            rep to let them receive them too - they answer from their console login.
          </p>
        </div>
        {eligible.length === 0 ? (
          <EmptyState
            title="No telecallers or sales reps with a login"
            description="Invite them from Team & permissions, and they can be made seniors here."
          />
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-subtle text-left">
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Person</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Role</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Can receive escalations</th>
                </tr>
              </thead>
              <tbody>
                {eligible.map((m) => (
                  <tr key={m.membershipId} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3 font-medium text-text">{m.name}</td>
                    <td className="px-3 py-3 text-text-muted">{roleLabel(m.ownerRole)}</td>
                    <td className="px-3 py-3">
                      <Toggle
                        on={m.senior}
                        label={`${m.name} can receive escalations`}
                        disabled={pending || !canEdit}
                        onChange={(next) => setSenior(m, next)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section aria-labelledby="esc-routing" className="space-y-3">
        <div>
          <h2 id="esc-routing" className="text-sm font-semibold text-text">
            Who each telecaller escalates to
          </h2>
          <p className="text-xs text-text-muted">
            By default an escalation goes to the manager the telecaller reports to (set in Attendance
            settings), and with none, to every owner and manager. Pick someone to send theirs straight to
            that person instead.
          </p>
        </div>
        {settings.telecallers.length === 0 ? (
          <EmptyState
            title="No telecallers yet"
            description="Telecallers appear here once a phone is paired for them on the Phones page."
          />
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-subtle text-left">
                  <th className="px-4 py-2.5 text-xs font-medium text-text-muted">Telecaller</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Escalates to</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Reaches now</th>
                </tr>
              </thead>
              <tbody>
                {settings.telecallers.map((t) => {
                  // A pointer to somebody who can no longer receive is skipped
                  // when an escalation is raised; offer it so the select says
                  // what is stored, and name why it is not used.
                  const stale =
                    t.escalateToMembershipId !== null &&
                    !recipients.some((r) => r.membershipId === t.escalateToMembershipId);
                  return (
                    <tr key={t.telecallerId} className="border-b border-border/60 align-top last:border-0">
                      <td className="px-4 py-3 font-medium text-text">{t.name}</td>
                      <td className="px-3 py-3">
                        <Select
                          size="sm"
                          aria-label={`Who ${t.name} escalates to`}
                          value={t.escalateToMembershipId ?? DEFAULT}
                          disabled={pending || !canEdit}
                          onChange={(e) => setRecipient(t, e.target.value)}
                        >
                          <option value={DEFAULT}>{defaultLabel(t)}</option>
                          {stale && t.escalateToMembershipId ? (
                            <option value={t.escalateToMembershipId}>
                              {nameOf(t.escalateToMembershipId) ?? "Someone"} (can no longer receive)
                            </option>
                          ) : null}
                          {recipients.map((r) => (
                            <option key={r.membershipId} value={r.membershipId}>
                              {recipientLabel(r)}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-3 py-3 text-text">
                        {t.effectiveRecipientName ?? ESCALATION_POOL_LABEL}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}
