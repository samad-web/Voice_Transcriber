"use client";

import { useMemo, useState, useTransition } from "react";
import { Button, Card, Checkbox, Select, StatusChip } from "@aura/ui";
import { formatMoney } from "@aura/shared";
import type { UsersResponse } from "./page";
import {
  acknowledgeNotice,
  bulkSetGate,
  setOrgGate,
  setUserGate,
  type GateActionResult,
} from "./actions";

/**
 * §3A.6's switchboard.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE MASTER SWITCH DOES NOT SWITCH ANYBODY ON
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This is the single most important thing for the page to make obvious, and it
 * is a deliberate product decision rather than a limitation.
 *
 * §3A.1 step 4's resolution means the org row is a CEILING, not a grant: the
 * assistant is off for every person until somebody is switched on in the table
 * below. Enabling the feature and finding nothing happens would otherwise look
 * broken - so the panel says it in words, and the table is on the same screen.
 *
 * The alternative (master switch turns everybody on) was rejected because it
 * hands a hundred telecallers' recorded calls to a model on one click, which is
 * exactly what §3A.6's per-user table exists to prevent.
 */

interface Spec {
  key: string;
  name: string;
  description: string;
  modes: Array<{ key: string; label: string; blurb: string }>;
  capabilities: Array<{ key: string; label: string; blurb: string }>;
  defaultModeOnEnable: string;
  defaultCapabilitiesOnEnable: string[];
  consentNoticeVersion: string;
}

export function AgentSwitchboard({
  spec,
  data,
}: {
  spec: Spec;
  data: UsersResponse | null;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<GateActionResult | null>(null);

  const orgOn = data?.org?.state === "on";
  const [maxMode, setMaxMode] = useState(
    data?.org?.mode ?? spec.defaultModeOnEnable,
  );
  const [capabilities, setCapabilities] = useState<string[]>(
    data?.org?.capabilities ?? [...spec.defaultCapabilitiesOnEnable],
  );
  const [selected, setSelected] = useState<string[]>([]);

  const run = (action: () => Promise<GateActionResult>) => {
    setResult(null);
    startTransition(async () => setResult(await action()));
  };

  const onCount = useMemo(
    () => (data?.users ?? []).filter((u) => u.state === "on").length,
    [data],
  );

  const needsConsent = result?.code === "consent_required";

  return (
    <div className="flex flex-col gap-6">
      {/* ── The master switch ────────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">{spec.name}</h2>
                {orgOn ? (
                  <StatusChip tone="solid">On for this workspace</StatusChip>
                ) : (
                  <StatusChip tone="outline">Off</StatusChip>
                )}
              </div>
              <p className="mt-2 max-w-prose text-sm text-text-muted">{spec.description}</p>
            </div>
            <Button
              variant={orgOn ? "secondary" : "primary"}
              disabled={pending}
              loading={pending}
              onClick={() =>
                run(() =>
                  setOrgGate({
                    state: orgOn ? "off" : "on",
                    maxMode,
                    capabilities,
                  }),
                )
              }
            >
              {orgOn ? "Switch off for the workspace" : "Switch on for the workspace"}
            </Button>
          </div>

          {/* The sentence the whole page turns on. See the header. */}
          {orgOn ? (
            <p className="max-w-prose rounded-md bg-surface-hover p-3 text-sm">
              This is a ceiling, not a switch for everybody.{" "}
              {onCount === 0 ? (
                <>
                  Nobody is switched on yet, so nothing is happening. Pick people in the
                  table below.
                </>
              ) : (
                <>
                  It is on for {onCount} {onCount === 1 ? "person" : "people"}, and nobody
                  else.
                </>
              )}
            </p>
          ) : null}

          {needsConsent ? (
            <div className="rounded-md border border-border-strong p-4">
              <h3 className="text-sm font-semibold">Before this can be switched on</h3>
              <p className="mt-2 max-w-prose text-sm text-text-muted">
                Switching this on means a language model reads written records of your
                customers&rsquo; phone calls in order to work out what was agreed. Card
                numbers, one-time passwords and identity numbers are masked before it sees
                anything. Nothing is sent to a customer without one of your people
                approving it.
              </p>
              <p className="mt-2 max-w-prose text-sm text-text-muted">
                You are confirming that your call recording and transcription notices cover
                this, and that you have whatever consent your customers are owed.
              </p>
              <Button
                className="mt-3"
                disabled={pending}
                onClick={() => run(() => acknowledgeNotice(spec.consentNoticeVersion))}
              >
                I understand — record that
              </Button>
            </div>
          ) : null}

          {/* §3A.5's "states exactly what will happen", as the API's own counts. */}
          {result?.consequences ? (
            <div className="rounded-md border border-border-strong p-4 text-sm">
              <p className="font-semibold">What happened to the work in flight</p>
              <ul className="mt-2 list-disc pl-5 text-text-muted">
                <li>
                  {result.consequences.pendingReviewFrozen} suggestion(s) are frozen — they
                  come back if you switch it on again within two weeks.
                </li>
                <li>{result.consequences.runsHeld} call(s) waiting to be read were held.</li>
                <li>
                  {result.consequences.callbacksConvertedToTasks} promised call-back(s) will
                  become ordinary follow-ups, with no reminders. Nothing is lost.
                </li>
                <li>
                  {result.consequences.alreadyCreatedKept} thing(s) it already created stay
                  exactly as they are.
                </li>
              </ul>
            </div>
          ) : null}

          {result?.error ? (
            <p role="alert" className="text-sm font-medium">
              {result.error}
            </p>
          ) : null}
        </div>
      </Card>

      {/* ── The maximum mode ─────────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="text-base font-semibold">The most it may do</h2>
            <p className="mt-1 max-w-prose text-sm text-text-muted">
              Nobody can be set higher than this, whatever their own setting says.
            </p>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">Maximum mode</legend>
            {spec.modes
              .filter((mode) => mode.key !== "off")
              .map((mode) => (
                <label key={mode.key} className="flex cursor-pointer items-start gap-3">
                  <input
                    type="radio"
                    name="maxMode"
                    value={mode.key}
                    checked={maxMode === mode.key}
                    onChange={() => setMaxMode(mode.key)}
                    disabled={pending}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-sm font-medium">{mode.label}</span>
                    {/* §3A.6: "with a plain-language explanation of each" -
                        served from the catalogue so the words an owner reads
                        are the words the gate enforces. */}
                    <span className="block max-w-prose text-sm text-text-muted">
                      {mode.blurb}
                    </span>
                  </span>
                </label>
              ))}
          </fieldset>

          <div>
            <h3 className="text-sm font-semibold">What it may do</h3>
            <p className="mt-1 max-w-prose text-sm text-text-muted">
              Each of these is separate. Leave anything off that you would rather do
              yourself.
            </p>
            <div className="mt-3 flex flex-col gap-3">
              {spec.capabilities
                .filter((capability) => capability.key !== "live_assist")
                .map((capability) => (
                  <Checkbox
                    key={capability.key}
                    label={capability.label}
                    // §3A.6's "plain-language explanation of each", in the
                    // component's own secondary slot rather than a sibling
                    // span - so the description is associated with the control
                    // for a screen reader instead of merely near it.
                    description={capability.blurb}
                    checked={capabilities.includes(capability.key)}
                    disabled={pending}
                    onChange={(event) =>
                      setCapabilities((current) =>
                        event.currentTarget.checked
                          ? [...current, capability.key]
                          : current.filter((key) => key !== capability.key),
                      )
                    }
                  />
                ))}
            </div>
          </div>

          <div>
            <Button
              disabled={pending}
              loading={pending}
              onClick={() =>
                run(() =>
                  setOrgGate({ state: orgOn ? "on" : "off", maxMode, capabilities }),
                )
              }
            >
              Save what it may do
            </Button>
          </div>
        </div>
      </Card>

      {/* ── §3A.6's users table ──────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Who it is on for</h2>
              <p className="mt-1 max-w-prose text-sm text-text-muted">
                Off for everybody until you pick them. A person with no console login is
                still listed — most telecallers only carry a phone.
              </p>
            </div>
            {selected.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">{selected.length} selected</span>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      bulkSetGate({
                        target: { kind: "users", userIds: selected },
                        state: "on",
                        mode: null,
                        capabilities: null,
                      }),
                    )
                  }
                >
                  Switch on
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      bulkSetGate({
                        target: { kind: "users", userIds: selected },
                        state: "off",
                      }),
                    )
                  }
                >
                  Switch off
                </Button>
              </div>
            ) : null}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-strong text-left">
                  <th scope="col" className="w-8 p-2">
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col" className="p-2">
                    Person
                  </th>
                  <th scope="col" className="p-2">
                    On
                  </th>
                  <th scope="col" className="p-2">
                    Mode
                  </th>
                  <th scope="col" className="p-2 text-right">
                    Calls read
                  </th>
                  <th scope="col" className="p-2 text-right">
                    Cost
                  </th>
                  <th scope="col" className="p-2 text-right">
                    Accuracy
                  </th>
                </tr>
              </thead>
              <tbody>
                {(data?.users ?? []).map((person) => {
                  const key = person.userId ?? person.telecallerId ?? person.name;
                  return (
                    <tr key={key} className="border-b border-border-strong/50">
                      <td className="p-2">
                        {person.userId ? (
                          <Checkbox
                            label={
                              <span className="sr-only">Select {person.name}</span>
                            }
                            checked={selected.includes(person.userId)}
                            disabled={pending}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.currentTarget.checked
                                  ? [...current, person.userId!]
                                  : current.filter((id) => id !== person.userId),
                              )
                            }
                          />
                        ) : null}
                      </td>
                      <td className="p-2">
                        <span className="font-medium">{person.name}</span>
                        {person.position || person.teamName ? (
                          <span className="block text-xs text-text-muted">
                            {[person.position, person.teamName].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                        {!person.userId ? (
                          <span className="block text-xs text-text-muted">
                            phone only — no console login
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2">
                        {person.state === "on" ? (
                          <StatusChip tone="solid">On</StatusChip>
                        ) : person.state === "off" ? (
                          <StatusChip tone="outline">Off</StatusChip>
                        ) : (
                          <StatusChip tone="muted">Not set</StatusChip>
                        )}
                      </td>
                      <td className="p-2">
                        <Select
                          aria-label={`Mode for ${person.name}`}
                          value={person.state === "on" ? person.mode : ""}
                          disabled={pending || !person.userId}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            if (!person.userId) return;
                            run(() =>
                              setUserGate(person.userId!, {
                                state: value ? "on" : "off",
                                mode: value || null,
                              }),
                            );
                          }}
                        >
                          <option value="">Off</option>
                          {spec.modes
                            .filter((mode) => mode.key !== "off")
                            .map((mode) => (
                              <option key={mode.key} value={mode.key}>
                                {mode.label}
                              </option>
                            ))}
                        </Select>
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {person.usage.transcripts}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {formatMoney(person.usage.modelCostMinor)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {/* §3A.7: usage and accuracy side by side, "so owners
                            can decide where the feature pays off". NULL below a
                            floor rather than a flattering number: a precision of
                            100% over two decisions misleads, and §13.3's gate
                            needs 200. */}
                        {person.precision === null ? (
                          <span className="text-text-muted">
                            {person.reviewedCases === 0
                              ? "—"
                              : `${person.reviewedCases} checked`}
                          </span>
                        ) : (
                          `${Math.round(person.precision * 100)}%`
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {(data?.users ?? []).length === 0 ? (
            <p className="text-sm text-text-muted">
              Nobody to show yet. Add your team and pair their phones first.
            </p>
          ) : null}

          {result?.clampedToOrgMaximum ? (
            <p className="text-sm">
              Saved as{" "}
              <strong>
                {spec.modes.find((m) => m.key === result.clampedToOrgMaximum)?.label ??
                  result.clampedToOrgMaximum}
              </strong>
              , which is the most this workspace allows.
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
