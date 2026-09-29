"use client";

import { useMemo, useState, useTransition } from "react";
import { Button, Card, ErrorBanner, FormField, MonoLabel, useToast } from "@aura/ui";
import {
  ABSENCE_MESSAGE_MAX,
  ABSENCE_MESSAGE_PRESETS,
  ABSENCE_PLACEHOLDERS,
  renderAbsenceMessage,
  validateAbsenceMessage,
} from "@aura/shared";
import type { AttendanceSettings } from "@/lib/attendance";
import { useServerState } from "@/lib/use-server-state";
// The kit has no Textarea primitive; every console textarea mirrors the
// control chrome by hand, and this one borrows the string rather than growing
// a fifth copy of it.
import { TEXTAREA_CLASS } from "../../agents/field-list";
import { updateAttendanceSettingsAction } from "./actions";

/**
 * The wording of the shift-not-started alert (0143), and the ten presets to
 * start from.
 *
 * ── WHY A PREVIEW AND NOT JUST A BOX ───────────────────────────────────────
 *
 * The placeholders are the whole point and they are also the whole risk: a
 * manager who types {{telecaller}} instead of {{name}} has written something
 * that looks right and is not. Two things catch that. The preview renders
 * against a worked example as they type, so a wrong placeholder is visible
 * before saving; and `validateAbsenceMessage` - the same function the API
 * refuses with - names it if they save anyway.
 *
 * The example is deliberately a real-looking one. A preview full of ALL-CAPS
 * tokens proves the substitution ran and nothing about how the sentence reads
 * at 9:45 on a Tuesday.
 *
 * ── WHY THE DEFAULT IS A PLACEHOLDER, NOT PREFILLED TEXT ───────────────────
 *
 * An untouched workspace stores null. Prefilling the box with the default
 * would make "I have not chosen" indistinguishable from "I chose this", and
 * the next time we improve the default wording, theirs would silently not
 * improve with it. So the box is empty, the default shows through it, and
 * clearing the box puts them back to null.
 */

/** 9:30 am start, 15-minute grace, read at 10:15 am on 29 September. */
const EXAMPLE_NOW = Date.parse("2026-09-29T04:45:00Z");
const EXAMPLE = {
  name: "Samad Rahman",
  shiftName: "Morning",
  shiftStart: Date.parse("2026-09-29T04:00:00Z"),
  shiftEnd: Date.parse("2026-09-29T12:30:00Z"),
  graceMinutes: 15,
  now: EXAMPLE_NOW,
  zone: "Asia/Kolkata",
  workspace: "your workspace",
};

export function AbsenceMessageEditor({ initial }: { initial: AttendanceSettings }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [settings, setSettings] = useServerState(initial);
  const [body, setBody] = useState(initial.absentMessage ?? "");
  const [error, setError] = useState<string | null>(null);

  const example = useMemo(() => ({ ...EXAMPLE, workspace: "Your workspace" }), []);
  const effective = body.trim() || settings.absentMessageDefault;
  // Only surfaced once they have typed something wrong - an empty box is not a
  // mistake, it is the default.
  const problem = body.trim() ? validateAbsenceMessage(body) : null;
  const preview = problem ? null : renderAbsenceMessage(effective, example);

  const dirty = (body.trim() || null) !== (settings.absentMessage ?? null);
  const usingDefault = !settings.absentMessage;

  const save = (next: string | null) => {
    setError(null);
    if (next) {
      const bad = validateAbsenceMessage(next);
      if (bad) {
        setError(bad);
        return;
      }
    }
    startTransition(async () => {
      const result = await updateAttendanceSettingsAction({ absentMessage: next });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.settings) {
        setSettings(result.settings);
        setBody(result.settings.absentMessage ?? "");
      }
      toast(next ? "Absence message saved" : "Back to the default message");
    });
  };

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">When a telecaller has not started their shift</h3>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          Sent once, to their manager, when the shift&rsquo;s grace period passes with no sign of
          them. Nothing is sent to the telecaller, and nothing is ever sent to a customer.
        </p>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div>
        <MonoLabel>Start from a ready-made one</MonoLabel>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ABSENCE_MESSAGE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={pending}
              onClick={() => {
                setBody(preset.body);
                setError(null);
              }}
              title={preset.body}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 ease-out ${
                body.trim() === preset.body
                  ? "border-transparent bg-text text-bg"
                  : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <FormField
        label="The message"
        name="absent-message"
        error={problem}
        hint={`${effective.length} of ${ABSENCE_MESSAGE_MAX} characters.${
          usingDefault && !body.trim() ? " Leave it empty to keep the default below." : ""
        }`}
      >
        <textarea
          rows={3}
          className={TEXTAREA_CLASS}
          value={body}
          maxLength={ABSENCE_MESSAGE_MAX}
          placeholder={settings.absentMessageDefault}
          disabled={pending}
          onChange={(e) => {
            setBody(e.target.value);
            setError(null);
          }}
        />
      </FormField>

      <div className="rounded-md border border-border bg-bg-subtle p-3">
        <MonoLabel>What their manager would read</MonoLabel>
        {preview ? (
          <p className="mt-1.5 text-sm text-text">{preview}</p>
        ) : (
          <p className="mt-1.5 text-sm text-text-muted">Fix the message above to see the preview.</p>
        )}
        <p className="mt-2 text-xs text-text-subtle">
          A link to the attendance board is added at the end - you do not need to write one.
        </p>
      </div>

      <div>
        <MonoLabel>Placeholders you can use</MonoLabel>
        <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          {Object.entries(ABSENCE_PLACEHOLDERS).map(([key, help]) => (
            <div key={key} className="flex flex-wrap items-baseline gap-x-2">
              <dt>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setBody((b) => `${b}{{${key}}}`);
                    setError(null);
                  }}
                  className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-xs text-accent-text hover:bg-surface-hover"
                >
                  {`{{${key}}}`}
                </button>
              </dt>
              <dd className="text-xs text-text-muted">{help}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={pending || !dirty || Boolean(problem)} onClick={() => save(body.trim() || null)}>
          Save
        </Button>
        {settings.absentMessage ? (
          <Button type="button" variant="secondary" disabled={pending} onClick={() => save(null)}>
            Use the default
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
