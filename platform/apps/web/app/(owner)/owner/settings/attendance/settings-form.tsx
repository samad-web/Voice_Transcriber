"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  Button,
  Card,
  ErrorBanner,
  FormField,
  Input,
  MonoLabel,
  Radio,
  RadioGroup,
  Select,
  useConfirm,
  useToast,
} from "@aura/ui";
import { ATTENDANCE_NOTICE_TEXT, AttendanceSettingsInput } from "@aura/shared";
import { useServerState } from "@/lib/use-server-state";
import type { AttendanceSettings } from "@/lib/attendance";
import { updateAttendanceSettingsAction } from "./actions";
import { Toggle } from "./toggle";

/**
 * The workspace switch, the escalation window and the WhatsApp alert toggle
 * (doc 33 §6.3, §6.4, §7.2). Each saves on its own, so changing one never
 * resends - and never silently reverts - another.
 */
export function AttendanceSettingsForm({ initial }: { initial: AttendanceSettings }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Follows the server (a colleague's save arrives through the realtime
  // refresh) until the person starts editing a field here.
  const [settings, setSettings] = useServerState(initial);
  const [hours, setHours] = useState(String(initial.leaveEscalationHours));
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState(initial.whatsappAlerts);
  const [channelId, setChannelId] = useState(initial.whatsappChannelId ?? "");
  const [waError, setWaError] = useState<string | null>(null);

  const save = (patch: Record<string, unknown>, done: string, onFieldError?: (msg: string) => void) => {
    setError(null);
    const parsed = AttendanceSettingsInput.safeParse(patch);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Check the value and try again.";
      if (onFieldError) onFieldError(message);
      else setError(message);
      return;
    }
    startTransition(async () => {
      const result = await updateAttendanceSettingsAction(parsed.data);
      if (result.error) {
        if (onFieldError) onFieldError(result.error);
        else setError(result.error);
        return;
      }
      if (result.settings) {
        setSettings(result.settings);
        setHours(String(result.settings.leaveEscalationHours));
        setAlerts(result.settings.whatsappAlerts);
        setChannelId(result.settings.whatsappChannelId ?? "");
      }
      toast(done);
    });
  };

  const toggleEnabled = async (next: boolean) => {
    if (next) {
      const ok = await confirm({
        title: "Start tracking attendance on handsets?",
        body: (
          <>
            Phones on app 1.2.0 or newer will start recording shift start and end, breaks, call
            activity and presence checks during each telecaller&rsquo;s shift hours - after the
            telecaller accepts the notice on their phone. Nothing is recorded outside shift hours.
          </>
        ),
        confirmLabel: "Start tracking",
      });
      if (!ok) return;
    }
    save({ enabled: next }, next ? "Attendance tracking is on" : "Attendance tracking is off");
  };

  const channels = settings.channels;
  const hasChannels = channels.length > 0;
  const canEditWa = settings.canEditWhatsapp;
  const selectedChannel = channels.find((c) => c.id === channelId) ?? null;

  const saveWhatsapp = () => {
    setWaError(null);
    if (alerts && !channelId) {
      setWaError("Choose the number the alerts are sent from.");
      return;
    }
    if (alerts && selectedChannel?.templateApproved === false) {
      setWaError("That number's message template is still waiting for Meta's approval.");
      return;
    }
    save(
      { whatsappAlerts: alerts, whatsappChannelId: alerts ? channelId : (channelId || null) },
      alerts ? "Approvers will be told on WhatsApp too" : "Approvers will be told in the console only",
      setWaError,
    );
  };

  const waDirty =
    alerts !== settings.whatsappAlerts || (channelId || null) !== (settings.whatsappChannelId ?? null);

  return (
    <div className="space-y-4">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text">Track attendance on handsets</h3>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">
              Nothing is tracked until this is on. Phones need the Aura app 1.2.0 or newer, and each
              telecaller must accept a notice on their phone saying what is recorded before tracking
              starts for them.
            </p>
          </div>
          <Toggle
            on={settings.enabled}
            label="Track attendance on handsets"
            disabled={pending}
            onChange={(next) => void toggleEnabled(next)}
          />
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-text-muted hover:text-text">
            The notice telecallers are asked to accept
          </summary>
          <p className="mt-2 max-w-2xl rounded-md border border-border bg-bg-subtle p-3 text-text">
            {ATTENDANCE_NOTICE_TEXT}
          </p>
        </details>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-text">When a manager does not answer</h3>
        <form
          className="flex flex-wrap items-start gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setHoursError(null);
            save(
              { leaveEscalationHours: Number(hours) },
              "Escalation window saved",
              setHoursError,
            );
          }}
        >
          <FormField
            label="Also tell the owners after (hours)"
            name="leave-escalation-hours"
            error={hoursError}
            hint="Or 2 hours before the leave starts, whichever comes first."
            className="max-w-xs"
          >
            <Input
              type="number"
              min={1}
              max={168}
              step={1}
              inputMode="numeric"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </FormField>
          {/* Down by the label's height (20px line + the field's 6px gap), so it
              lines up with the input rather than the hint under it. */}
          <Button
            type="submit"
            variant="secondary"
            className="mt-[26px]"
            disabled={pending || hours === String(settings.leaveEscalationHours)}
          >
            Save
          </Button>
        </form>
      </Card>

      <Card className="space-y-3">
        <RadioGroup
          legend="Tell approvers about requests"
          hint={
            canEditWa
              ? "Approvers are always told in the console. WhatsApp adds a message from your own business number, never with the telecaller's reason in it."
              : "Only an owner of this workspace can change this."
          }
        >
          <Radio
            name="wa-alerts"
            label="In the console only"
            checked={!alerts}
            disabled={!canEditWa || pending}
            onChange={() => setAlerts(false)}
          />
          <Radio
            name="wa-alerts"
            label="In the console and on WhatsApp"
            description={
              hasChannels ? undefined : "Connect a WhatsApp Business number in Conversations first."
            }
            checked={alerts}
            disabled={!canEditWa || !hasChannels || pending}
            onChange={() => setAlerts(true)}
          />
        </RadioGroup>

        {hasChannels ? (
          <FormField
            label="Sent from"
            name="wa-channel"
            error={waError}
            hint={
              selectedChannel?.templateApproved === false
                ? "Waiting for Meta to approve the template for this number."
                : undefined
            }
            className="max-w-md"
          >
            <Select
              value={channelId}
              disabled={!canEditWa || !alerts || pending}
              onChange={(e) => setChannelId(e.target.value)}
            >
              <option value="">Choose a number</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id} disabled={c.templateApproved === false}>
                  {c.label}
                  {c.templateApproved === false ? " - waiting for Meta to approve the template" : ""}
                </option>
              ))}
            </Select>
          </FormField>
        ) : waError ? (
          <ErrorBanner>{waError}</ErrorBanner>
        ) : null}

        {/*
          Reported, not enforced. Absence alerts (0143) carry the workspace's
          own wording, which Meta will only deliver through a template of its
          own; until that is approved those alerts stay in the console. Said
          here rather than in the editor because it is a property of the NUMBER,
          not of the message - and it must not block turning alerts on, since
          request alerts are unaffected.
        */}
        {alerts && selectedChannel?.absenceTemplateApproved === false ? (
          <p className="text-sm text-text-muted">
            Requests will reach WhatsApp. Shift-not-started alerts will stay in the console until
            Meta approves a Utility template named{" "}
            <span className="font-mono text-xs text-text">attendance_absence_alert</span> with 2
            variables (the message, and a link) on this number.
          </p>
        ) : null}

        {canEditWa ? (
          <div>
            <Button type="button" variant="secondary" disabled={pending || !waDirty} onClick={saveWhatsapp}>
              Save
            </Button>
          </div>
        ) : null}

        {settings.approversWithoutWhatsapp.length > 0 ? (
          <div className="rounded-md border border-border bg-bg-subtle p-3">
            <MonoLabel>
              {settings.approversWithoutWhatsapp.length === 1
                ? "1 approver has no WhatsApp number"
                : `${settings.approversWithoutWhatsapp.length} approvers have no WhatsApp number`}
            </MonoLabel>
            <p className="mt-1 text-sm text-text-muted">
              They are told in the console only. Add a number on their Staff profile.
            </p>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {settings.approversWithoutWhatsapp.map((a) => (
                <li key={a.membershipId}>
                  <Link
                    href="/owner/staff?tab=team"
                    className="text-accent-text underline-offset-2 hover:underline"
                  >
                    {a.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
