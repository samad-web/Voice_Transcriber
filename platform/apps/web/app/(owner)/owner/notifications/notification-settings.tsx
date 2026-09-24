"use client";

import { useState } from "react";
import { useDraftState } from "@/lib/use-server-state";
import type { NotificationKind } from "@aura/shared";
import { Button, FormField, InfoHint, Select, useAlert } from "@aura/ui";
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_ORDER,
  describeDelivery,
  formatDigestHour,
} from "@/lib/notification-kinds";
import { saveNotificationPreferencesAction, type NotificationPreferences } from "./actions";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * Instant or Digest, per kind, plus the hour a digest arrives.
 *
 * Saved as one PUT of the whole choice rather than a request per toggle: the
 * API also re-slots what is already held when the hour or a kind changes, and
 * doing that once per click would move the same rows back and forth.
 */
export function NotificationSettings({ initial }: { initial: NotificationPreferences }) {
  const [saved, setSaved] = useDraftState(initial);
  const [digest, setDigest] = useState<Set<NotificationKind>>(() => new Set(initial.digestKinds));
  const [hour, setHour] = useDraftState(initial.digestHour);
  const [busy, setBusy] = useState(false);
  const alert = useAlert();

  const dirty =
    hour !== saved.digestHour ||
    digest.size !== saved.digestKinds.length ||
    saved.digestKinds.some((kind) => !digest.has(kind));

  const choose = (kind: NotificationKind, mode: "instant" | "digest") =>
    setDigest((prev) => {
      const next = new Set(prev);
      if (mode === "digest") next.add(kind);
      else next.delete(kind);
      return next;
    });

  const save = async () => {
    setBusy(true);
    const res = await saveNotificationPreferencesAction({ digestKinds: [...digest], digestHour: hour });
    setBusy(false);
    if (res.error || !res.preferences) {
      await alert({ title: "Couldn't save your notification settings", body: res.error, tone: "danger" });
      return;
    }
    setSaved(res.preferences);
    setDigest(new Set(res.preferences.digestKinds));
    setHour(res.preferences.digestHour);
  };

  return (
    <div className="space-y-5">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {NOTIFICATION_KIND_ORDER.map((kind) => {
          const spec = NOTIFICATION_KINDS[kind];
          const mode = digest.has(kind) ? "digest" : "instant";
          return (
            <li key={kind} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-text">
                  {spec.label}
                  <InfoHint label={spec.label} content={spec.description} />
                </p>
                <p className="text-xs text-text-muted">{spec.description}</p>
              </div>
              <fieldset className="flex shrink-0 rounded-full border border-border-strong p-0.5">
                <legend className="sr-only">How to deliver {spec.label}</legend>
                {(["instant", "digest"] as const).map((option) => (
                  <label
                    key={option}
                    className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors duration-150 ease-out has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 ${
                      mode === option ? "bg-text text-bg" : "text-text-muted hover:text-text"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`delivery-${kind}`}
                      value={option}
                      checked={mode === option}
                      onChange={() => choose(kind, option)}
                      className="sr-only"
                    />
                    {option === "instant" ? "Instant" : "Digest"}
                  </label>
                ))}
              </fieldset>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <FormField
          label="Digest arrives at"
          name="digestHour"
          hint="In your organisation's reporting timezone. Held notifications appear in the bell together."
          className="sm:w-72"
        >
          <Select value={hour} onChange={(event) => setHour(Number(event.target.value))}>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {formatDigestHour(h)}
              </option>
            ))}
          </Select>
        </FormField>
        <Button type="button" loading={busy} disabled={!dirty} onClick={() => void save()} className="sm:mb-6">
          Save notification settings
        </Button>
      </div>

      <p className="text-xs text-text-muted" aria-live="polite">
        {saved.held > 0 && saved.nextDigestAt
          ? `${saved.held} notification${saved.held === 1 ? " is" : "s are"} held for your next digest, arriving ${describeDelivery(saved.nextDigestAt, new Date())}.`
          : "Nothing is held right now."}{" "}
        A digest only changes when the bell shows something. Nothing is emailed or sent anywhere.
      </p>
    </div>
  );
}
