"use client";

import { useState, useTransition } from "react";
import { Button, Card, EmptyState, ErrorBanner, Select, StatusChip, useToast } from "@aura/ui";
import { useServerState } from "@/lib/use-server-state";
import type { Approver, AttendancePerson, ShiftPattern } from "@/lib/attendance";
import { updatePeopleAction } from "./actions";
import { Toggle } from "./toggle";

/** A select's value for "no pattern" / "the owners" - `null` on the wire. */
const NONE = "__none__";
/** A bulk select left alone - the field is not sent. */
const KEEP = "__keep__";

type Patch = {
  shiftPatternId?: string | null;
  reportsToMembershipId?: string | null;
  appLeaveRequests?: boolean;
  appBreakBooking?: boolean;
};

function approverLabel(a: Approver): string {
  return a.ownerRole ? `${a.name} (${a.ownerRole})` : a.name;
}

/**
 * One row per telecaller (doc 33 §7.1): their shift pattern, who they report
 * to, and the two per-person switches that decide whether their phone shows
 * "Apply for leave" and "Book a break". Any change pushes a config refresh to
 * their phone from the API.
 *
 * Every edit - one row or twelve - goes through the same `PUT people` with a
 * list of ids, so the bulk bar and a single select cannot disagree about what
 * a change means.
 */
export function PeopleTable({
  initial,
  approvers,
  patterns,
}: {
  initial: AttendancePerson[];
  approvers: Approver[];
  patterns: ShiftPattern[];
}) {
  const toast = useToast();
  const [people, setPeople] = useServerState(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [bulk, setBulk] = useState({ pattern: KEEP, reportsTo: KEEP, leave: KEEP, breaks: KEEP });

  const patternName = (id: string | null) => patterns.find((p) => p.id === id)?.name ?? null;
  const approverName = (id: string | null) => approvers.find((a) => a.membershipId === id)?.name ?? null;

  const apply = (ids: string[], patch: Patch, done: string) => {
    if (ids.length === 0 || Object.keys(patch).length === 0) return;
    setError(null);
    startTransition(async () => {
      const result = await updatePeopleAction({ telecallerIds: ids, ...patch });
      if (result.error) {
        setError(result.error);
        return;
      }
      const touched = new Set(ids);
      setPeople((list) =>
        list.map((p) => {
          if (!touched.has(p.telecallerId)) return p;
          const next = { ...p, ...patch } as AttendancePerson;
          if ("shiftPatternId" in patch) next.shiftPatternName = patternName(patch.shiftPatternId ?? null);
          if ("reportsToMembershipId" in patch) next.reportsToName = approverName(patch.reportsToMembershipId ?? null);
          return next;
        }),
      );
      toast(done);
    });
  };

  const allSelected = people.length > 0 && selected.size === people.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(people.map((p) => p.telecallerId)));
  const toggleOne = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const applyBulk = () => {
    const patch: Patch = {};
    if (bulk.pattern !== KEEP) patch.shiftPatternId = bulk.pattern === NONE ? null : bulk.pattern;
    if (bulk.reportsTo !== KEEP) patch.reportsToMembershipId = bulk.reportsTo === NONE ? null : bulk.reportsTo;
    if (bulk.leave !== KEEP) patch.appLeaveRequests = bulk.leave === "on";
    if (bulk.breaks !== KEEP) patch.appBreakBooking = bulk.breaks === "on";
    const n = selected.size;
    apply([...selected], patch, `Updated ${n} ${n === 1 ? "person" : "people"}`);
    setBulk({ pattern: KEEP, reportsTo: KEEP, leave: KEEP, breaks: KEEP });
  };

  const bulkDirty = Object.values(bulk).some((v) => v !== KEEP);

  if (people.length === 0) {
    return (
      <section aria-labelledby="att-people" className="space-y-3">
        <h2 id="att-people" className="text-sm font-semibold text-text">
          People
        </h2>
        <EmptyState
          title="No telecallers yet"
          description="Telecallers appear here once a phone is paired for them on the Phones page."
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="att-people" className="space-y-3">
      <div>
        <h2 id="att-people" className="text-sm font-semibold text-text">
          People
        </h2>
        <p className="text-xs text-text-muted">
          A new shift pattern takes effect today. Requests go to the person they report to; with nobody
          set, to every owner.
        </p>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {selected.size > 0 ? (
        <Card className="flex flex-wrap items-end gap-3">
          <p className="w-full text-sm font-medium text-text">
            {selected.size} selected - change for all of them:
          </p>
          <label className="flex min-w-40 flex-col gap-1 text-xs text-text-muted">
            Shift pattern
            <Select size="sm" value={bulk.pattern} onChange={(e) => setBulk((b) => ({ ...b, pattern: e.target.value }))}>
              <option value={KEEP}>Leave as is</option>
              <option value={NONE}>No pattern</option>
              {patterns.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-40 flex-col gap-1 text-xs text-text-muted">
            Reports to
            <Select
              size="sm"
              value={bulk.reportsTo}
              onChange={(e) => setBulk((b) => ({ ...b, reportsTo: e.target.value }))}
            >
              <option value={KEEP}>Leave as is</option>
              <option value={NONE}>The owners</option>
              {approvers.map((a) => (
                <option key={a.membershipId} value={a.membershipId}>
                  {approverLabel(a)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-36 flex-col gap-1 text-xs text-text-muted">
            Apply for leave in the app
            <Select size="sm" value={bulk.leave} onChange={(e) => setBulk((b) => ({ ...b, leave: e.target.value }))}>
              <option value={KEEP}>Leave as is</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </Select>
          </label>
          <label className="flex min-w-36 flex-col gap-1 text-xs text-text-muted">
            Book breaks in the app
            <Select size="sm" value={bulk.breaks} onChange={(e) => setBulk((b) => ({ ...b, breaks: e.target.value }))}>
              <option value={KEEP}>Leave as is</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </Select>
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={applyBulk} disabled={!bulkDirty} loading={pending}>
              Apply
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[60rem] text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-subtle text-left">
              <th className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select everyone"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer accent-accent"
                />
              </th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Telecaller</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Shift pattern</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Reports to</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Apply for leave in the app</th>
              <th className="px-3 py-2.5 text-xs font-medium text-text-muted">Book breaks in the app</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.telecallerId} className="border-b border-border/60 align-top last:border-0">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.name}`}
                    checked={selected.has(p.telecallerId)}
                    onChange={() => toggleOne(p.telecallerId)}
                    className="mt-0.5 h-4 w-4 cursor-pointer accent-accent"
                  />
                </td>
                <td className="px-3 py-3">
                  <p className="font-medium text-text">{p.name}</p>
                  <p className="text-xs text-text-muted">
                    {p.device
                      ? `${p.device.label ?? "Phone"}${p.device.appVersionCode ? ` · app build ${p.device.appVersionCode}` : ""}`
                      : "No phone paired"}
                  </p>
                  {p.needsAppUpdate ? (
                    <StatusChip tone="danger" className="mt-1.5">
                      Update the app first
                    </StatusChip>
                  ) : null}
                  {p.suggestedSilenceMinutes !== null ? (
                    <p className="mt-1 text-xs text-text-muted">
                      Suggested presence check: after {p.suggestedSilenceMinutes} min quiet
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-3">
                  <Select
                    size="sm"
                    aria-label={`Shift pattern for ${p.name}`}
                    value={p.shiftPatternId ?? NONE}
                    disabled={pending}
                    onChange={(e) =>
                      apply(
                        [p.telecallerId],
                        { shiftPatternId: e.target.value === NONE ? null : e.target.value },
                        `${p.name}'s shift updated`,
                      )
                    }
                  >
                    <option value={NONE}>No pattern</option>
                    {patterns.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-3 py-3">
                  <Select
                    size="sm"
                    aria-label={`Who ${p.name} reports to`}
                    value={p.reportsToMembershipId ?? NONE}
                    disabled={pending}
                    onChange={(e) =>
                      apply(
                        [p.telecallerId],
                        { reportsToMembershipId: e.target.value === NONE ? null : e.target.value },
                        `${p.name} now reports to ${
                          e.target.value === NONE ? "the owners" : (approverName(e.target.value) ?? "them")
                        }`,
                      )
                    }
                  >
                    <option value={NONE}>The owners</option>
                    {approvers.map((a) => (
                      <option key={a.membershipId} value={a.membershipId}>
                        {approverLabel(a)}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-3 py-3">
                  <Toggle
                    on={p.appLeaveRequests}
                    label={`Apply for leave in the app, for ${p.name}`}
                    disabled={pending}
                    onChange={(next) =>
                      apply([p.telecallerId], { appLeaveRequests: next }, next ? "Leave in the app on" : "Leave in the app off")
                    }
                  />
                </td>
                <td className="px-3 py-3">
                  <Toggle
                    on={p.appBreakBooking}
                    label={`Book breaks in the app, for ${p.name}`}
                    disabled={pending}
                    onChange={(next) =>
                      apply([p.telecallerId], { appBreakBooking: next }, next ? "Break booking on" : "Break booking off")
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}
