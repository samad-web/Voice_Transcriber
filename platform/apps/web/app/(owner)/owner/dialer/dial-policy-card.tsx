"use client";

import { useState, useTransition } from "react";
import { Card, ErrorBanner, MonoLabel, useToast } from "@aura/ui";
import type { DialSettingsView } from "@aura/shared/dist/dialer";
import { useServerState } from "@/lib/use-server-state";
import { Toggle } from "../settings/attendance/toggle";
import { updateDialSettingsAction } from "./actions";

/** 0..23 as "9am" / "9pm", because a 24-hour clock is not how a floor talks. */
function hourLabel(hour: number): string {
  if (hour === 0) return "midnight";
  if (hour === 12) return "noon";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * The org-wide dial policy: when we may ring, whom we may ring, and how often
 * we may ring the same person (Build docs/40 §B1).
 *
 * ── THE CEILING IS HERE AND NOT ON A SETTINGS PAGE ─────────────────────────
 *
 * `dialer_max_calls_per_person_per_day` is an ORG column, so the tidy home for
 * it is Settings. It is on the dialer page instead, directly above the campaign
 * list where `maxAttempts` is chosen, and that is the whole point of doc 39's
 * decision to ship it UNCAPPED.
 *
 * `maxAttempts` answers "how many times may we try this RECORD". The ceiling
 * answers "how many times may we ring this HUMAN today, across every campaign
 * at once". Two leads can be the same person - which is precisely the case a
 * per-campaign limit cannot see - so an owner who sets `maxAttempts: 5` on
 * three campaigns has authorised fifteen calls to one man in a morning. They
 * will not know that unless both numbers are in front of them when they choose.
 * Uncapped is a defensible default only while it is visible; on a settings page
 * nobody opens, it is a trap.
 *
 * ── AND WHY THE TIMEZONE IS NOT EDITABLE HERE ──────────────────────────────
 *
 * It is `organizations.reporting_timezone`, shared with every report in the
 * product and set under Time & location. A second place to change it would let
 * a tenant make the dialer's idea of 9pm differ from the dashboard's - doc 39
 * names the trap (a clinic in Kerala and a desk selling into Dubai held by the
 * same clock). Shown, so nobody reads "9pm" as their own wall clock, never
 * edited.
 */
export function DialPolicyCard({ initial }: { initial: DialSettingsView }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useServerState(initial);
  // The cap's own draft, because it is a text field rather than a toggle: an
  // empty box means uncapped and a half-typed "1" must not be sent as a cap of
  // 1 on the first keystroke.
  const [capDraft, setCapDraft] = useState<string>(
    initial.personDailyCap === null ? "" : String(initial.personDailyCap),
  );

  const save = (patch: Parameters<typeof updateDialSettingsAction>[0], done: string) => {
    setError(null);
    startTransition(async () => {
      const result = await updateDialSettingsAction(patch);
      if (result.error) {
        setError(result.error);
        // Put the field back to what the server still holds. A rejected cap
        // left in the box reads as saved.
        setCapDraft(settings.personDailyCap === null ? "" : String(settings.personDailyCap));
        return;
      }
      if (result.settings) {
        setSettings(() => result.settings!);
        setCapDraft(
          result.settings.personDailyCap === null ? "" : String(result.settings.personDailyCap),
        );
      }
      toast(done);
    });
  };

  const commitCap = () => {
    const trimmed = capDraft.trim();
    // An empty box is UNCAPPED, sent as an explicit null. The API binds a
    // sixth parameter precisely so this can be told apart from "not in the
    // body" - without it the field would be a one-way door.
    if (trimmed === "") {
      if (settings.personDailyCap === null) return;
      save({ personDailyCap: null }, "No daily limit per person");
      return;
    }
    const next = Number(trimmed);
    if (!Number.isInteger(next) || next < 1 || next > 50) {
      // Matches 0157's CHECK. Caught here so a typo is a sentence rather than
      // a 23514 that reads like a bug in the console.
      setError("A daily limit per person has to be a whole number between 1 and 50.");
      return;
    }
    if (next === settings.personDailyCap) return;
    save({ personDailyCap: next }, `At most ${next} calls to one person a day`);
  };

  const disabled = pending || !settings.canEdit;

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">Dial policy</h3>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          Applies to every campaign at once, and to every phone on the floor. A record the
          policy blocks is shown to the agent with the reason, never silently skipped.
        </p>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {!settings.canEdit ? (
        <p className="text-xs text-text-muted">
          You can see the policy but not change it. An owner or a manager sets this.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* ── The calling window ─────────────────────────────────────────── */}
        <div className="space-y-2">
          <MonoLabel>Calling hours</MonoLabel>
          <div className="flex items-center gap-2">
            <select
              aria-label="Earliest hour we may ring"
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text disabled:opacity-60"
              value={settings.startHour}
              disabled={disabled}
              onChange={(e) =>
                save({ startHour: Number(e.target.value) }, "Calling hours updated")
              }
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
            <span className="text-sm text-text-muted">to</span>
            <select
              aria-label="Latest hour we may ring"
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text disabled:opacity-60"
              value={settings.endHour}
              disabled={disabled}
              onChange={(e) => save({ endHour: Number(e.target.value) }, "Calling hours updated")}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-text-muted">
            In {settings.timeZone}, the workspace clock every report uses. Change it under Time
            &amp; location.
          </p>
        </div>

        {/* ── THE CEILING. Beside the hours, above the campaigns. ────────── */}
        <div className="space-y-2">
          <MonoLabel>Daily limit per person</MonoLabel>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={50}
              inputMode="numeric"
              aria-label="Most calls to one person in a day"
              placeholder="No limit"
              className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text disabled:opacity-60"
              value={capDraft}
              disabled={disabled}
              onChange={(e) => setCapDraft(e.target.value)}
              onBlur={commitCap}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitCap();
                }
              }}
            />
            <span className="text-sm text-text-muted">calls a day</span>
          </div>
          <p className="text-xs text-text-muted">
            {settings.personDailyCap === null
              ? "No limit. A campaign’s own “attempts” cap counts tries at one record — this counts calls to one PERSON across every campaign, which is different when the same human is on two lists. Leave empty for no limit."
              : `At most ${settings.personDailyCap} calls to the same person a day, however many campaigns they appear on. Clear the box for no limit.`}
          </p>
        </div>
      </div>

      {/* ── Unknown consent ─────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-text">
            Ring people whose consent we have not recorded
          </h4>
          <p className="mt-1 max-w-2xl text-sm text-text-muted">
            Off is the safe reading: a record with no consent either way is held back rather
            than rung. This never overrides a do-not-call list or someone who has opted out —
            those are refused whatever this says.
          </p>
        </div>
        <Toggle
          on={settings.allowsUnknownConsent}
          label="Ring people whose consent we have not recorded"
          disabled={disabled}
          onChange={(next) =>
            save(
              { allowsUnknownConsent: next },
              next ? "Unrecorded consent is dialable" : "Unrecorded consent is held back",
            )
          }
        />
      </div>
    </Card>
  );
}
