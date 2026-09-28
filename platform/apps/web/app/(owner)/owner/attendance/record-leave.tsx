"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Button, Dialog, ErrorBanner, FormField, Input, Select, useToast } from "@aura/ui";
import {
  LEAVE_TYPE_LABELS,
  LeaveType,
  OnBehalfRequestInput,
  timeZoneShortLabel,
  wallTimeToInstant,
} from "@aura/shared";
import { inputClass } from "@/lib/form";
import { issuesByField } from "@/lib/attendance";
import { recordRequestAction } from "./actions";

type Kind = "leave" | "break" | "hours_change";

/**
 * "Record leave" (doc 33 §6.1): an owner or manager records leave, a break or
 * changed hours for a telecaller, approved in the same step. Most telecallers
 * have no console login and some have the in-app switch off - a manager can
 * always record it for them.
 *
 * Times are typed on the WORKSPACE's clock and turned into instants with
 * `wallTimeToInstant` (Build docs/30), never the browser's zone.
 */
export function RecordLeave({
  people,
  zone,
  today,
}: {
  people: { id: string; name: string }[];
  zone: string;
  today: string;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    telecallerId: "",
    kind: "leave" as Kind,
    leaveType: "casual" as LeaveType,
    startDate: today,
    endDate: today,
    halfDay: "" as "" | "am" | "pm",
    date: today,
    startTime: "13:00",
    endTime: "14:00",
    reason: "",
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const close = () => {
    if (pending) return;
    setOpen(false);
    setError(null);
    setErrors({});
  };

  const submit = () => {
    setError(null);
    if (!form.telecallerId) {
      setErrors({ telecallerId: "Choose who this is for." });
      return;
    }
    const reason = form.reason.trim() || null;
    let input: unknown;
    if (form.kind === "leave") {
      input = {
        telecallerId: form.telecallerId,
        kind: "leave",
        leaveType: form.leaveType,
        startDate: form.startDate,
        endDate: form.halfDay ? form.startDate : form.endDate,
        halfDay: form.halfDay || null,
        reason,
      };
    } else {
      const startsAt = wallTimeToInstant(`${form.date}T${form.startTime}`, zone);
      // An end at or before the start is the next morning - the night-shift rule.
      let endsAt = wallTimeToInstant(`${form.date}T${form.endTime}`, zone);
      if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
        endsAt = new Date(Date.parse(endsAt) + 86_400_000).toISOString();
      }
      if (!startsAt || !endsAt) {
        setErrors({ startsAt: "Enter a date and both times." });
        return;
      }
      input = { telecallerId: form.telecallerId, kind: form.kind, startsAt, endsAt, reason };
    }
    const parsed = OnBehalfRequestInput.safeParse(input);
    if (!parsed.success) {
      // A union's mismatch has no field path ("form"); say it in the banner.
      const fieldErrors = issuesByField(parsed.error.issues);
      setErrors(fieldErrors);
      setError(fieldErrors.form ?? null);
      return;
    }
    setErrors({});
    startTransition(async () => {
      const result = await recordRequestAction(parsed.data);
      if (result.fieldErrors) setErrors(result.fieldErrors);
      if (result.error) {
        setError(result.error);
        return;
      }
      const name = people.find((p) => p.id === form.telecallerId)?.name ?? "them";
      toast(form.kind === "leave" ? `Leave recorded for ${name}` : `Recorded for ${name}`);
      setOpen(false);
      setForm((f) => ({ ...f, reason: "" }));
    });
  };

  const zoneLabel = timeZoneShortLabel(zone);

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Record leave
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title="Record leave or a break"
        description="Recorded on the telecaller's behalf and approved straight away."
        dismissOnBackdrop={false}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} loading={pending}>
              Record
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
          <FormField label="Telecaller" name="rec-who" error={errors.telecallerId} required>
            <Select value={form.telecallerId} onChange={(e) => set("telecallerId", e.target.value)}>
              <option value="">Choose a telecaller</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="What" name="rec-kind">
            <Select value={form.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
              <option value="leave">Leave</option>
              <option value="break">A break</option>
              <option value="hours_change">Different hours for a day</option>
            </Select>
          </FormField>

          {form.kind === "leave" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Type" name="rec-type">
                  <Select value={form.leaveType} onChange={(e) => set("leaveType", e.target.value as LeaveType)}>
                    {LeaveType.options.map((t) => (
                      <option key={t} value={t}>
                        {LEAVE_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Length" name="rec-half">
                  <Select value={form.halfDay} onChange={(e) => set("halfDay", e.target.value as "" | "am" | "pm")}>
                    <option value="">Full days</option>
                    <option value="am">Half day - morning</option>
                    <option value="pm">Half day - afternoon</option>
                  </Select>
                </FormField>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField label={form.halfDay ? "Date" : "From"} name="rec-from" error={errors.startDate}>
                  <Input type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
                </FormField>
                {!form.halfDay ? (
                  <FormField label="To" name="rec-to" error={errors.endDate ?? errors.halfDay}>
                    <Input type="date" value={form.endDate} onChange={(e) => set("endDate", e.target.value)} />
                  </FormField>
                ) : null}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <FormField label="Date" name="rec-date" error={errors.startsAt}>
                <Input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
              </FormField>
              <FormField label="From" name="rec-start" hint={zoneLabel}>
                <Input type="time" value={form.startTime} onChange={(e) => set("startTime", e.target.value)} />
              </FormField>
              <FormField label="To" name="rec-end" error={errors.endsAt} hint={zoneLabel}>
                <Input type="time" value={form.endTime} onChange={(e) => set("endTime", e.target.value)} />
              </FormField>
            </div>
          )}

          <FormField label="Reason (optional)" name="rec-reason" error={errors.reason}>
            <textarea
              rows={2}
              maxLength={500}
              value={form.reason}
              onChange={(e) => set("reason", e.target.value)}
              className={inputClass}
            />
          </FormField>
        </div>
      </Dialog>
    </>
  );
}
