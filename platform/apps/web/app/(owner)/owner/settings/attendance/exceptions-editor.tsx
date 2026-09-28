"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  FormField,
  Input,
  Select,
  StatusChip,
  useConfirm,
  useToast,
} from "@aura/ui";
import { ExceptionInput, formatDateKey, timeZoneShortLabel, weekdayOfDateKey } from "@aura/shared";
import { useServerState } from "@/lib/use-server-state";
import { issuesByField, wall, type AttendanceException, type AttendancePerson } from "@/lib/attendance";
import { createExceptionAction, deleteExceptionAction } from "./actions";

const KIND_LABEL: Record<AttendanceException["kind"], string> = {
  holiday: "Holiday",
  day_off: "Day off",
  custom_hours: "Custom hours",
};

/**
 * Holidays and one-off changes for a month (doc 33 §6.1): a workspace holiday
 * applies to everyone; a day off or custom hours applies to one person. The
 * month travels in the URL (`?month=`), so the list is fetched on the server
 * for exactly the month on screen.
 */
export function ExceptionsEditor({
  initial,
  people,
  month,
  monthLabel,
  prevHref,
  nextHref,
  zone,
}: {
  initial: AttendanceException[];
  people: AttendancePerson[];
  /** YYYY-MM on screen. */
  month: string;
  monthLabel: string;
  prevHref: string;
  nextHref: string;
  zone: string;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useServerState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<AttendanceException["kind"]>("holiday");
  const [onDate, setOnDate] = useState(`${month}-01`);
  const [telecallerId, setTelecallerId] = useState("");
  const [label, setLabel] = useState("");
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("16:00");

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const input = {
      telecallerId: kind === "holiday" ? null : telecallerId || null,
      onDate,
      kind,
      label: label.trim() || null,
      startTime: kind === "custom_hours" ? startTime : null,
      endTime: kind === "custom_hours" ? endTime : null,
    };
    if (kind !== "holiday" && !telecallerId) {
      setErrors({ telecallerId: "Choose who this is for." });
      return;
    }
    const parsed = ExceptionInput.safeParse(input);
    if (!parsed.success) {
      setErrors(issuesByField(parsed.error.issues));
      return;
    }
    setErrors({});
    startTransition(async () => {
      const result = await createExceptionAction(parsed.data);
      if (result.fieldErrors) setErrors(result.fieldErrors);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.exception && result.exception.onDate.startsWith(month)) {
        const created = result.exception;
        setItems((list) => [...list, created].sort((a, b) => a.onDate.localeCompare(b.onDate)));
      }
      setLabel("");
      toast(kind === "holiday" ? "Holiday added" : "Added");
    });
  };

  const remove = async (x: AttendanceException) => {
    const who = x.telecallerName ?? "everyone";
    const ok = await confirm({
      title: `Remove this ${KIND_LABEL[x.kind].toLowerCase()}?`,
      body: `${formatDateKey(x.onDate)} for ${who}. That day goes back to the normal shift.`,
      confirmLabel: "Remove",
      tone: "danger",
      requireTyped: false,
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteExceptionAction(x.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setItems((list) => list.filter((i) => i.id !== x.id));
      toast("Removed");
    });
  };

  return (
    <section aria-labelledby="att-exceptions" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="att-exceptions" className="text-sm font-semibold text-text">
          Holidays and exceptions
        </h2>
        <div className="flex items-center gap-1">
          <Link
            href={prevHref}
            aria-label="Previous month"
            className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <span className="min-w-28 text-center text-sm font-medium text-text tabular-nums">{monthLabel}</span>
          <Link
            href={nextHref}
            aria-label="Next month"
            className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {items.length === 0 ? (
        <EmptyState title={`Nothing in ${monthLabel}`} description="Every day follows each person's shift pattern." />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-text tabular-nums">
                    <span className="font-medium">
                      {weekdayOfDateKey(x.onDate)} {formatDateKey(x.onDate)}
                    </span>
                    {x.label ? <span className="text-text-muted"> · {x.label}</span> : null}
                  </p>
                  <p className="text-xs text-text-muted">
                    {x.telecallerName ?? "Everyone"}
                    {x.kind === "custom_hours" && x.startTime && x.endTime
                      ? ` · ${wall(x.startTime)}-${wall(x.endTime)}`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip tone="muted">{KIND_LABEL[x.kind]}</StatusChip>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void remove(x)} disabled={pending}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label="Add" name="exc-kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as AttendanceException["kind"])}>
              <option value="holiday">A holiday for everyone</option>
              <option value="day_off">A day off for one person</option>
              <option value="custom_hours">Different hours for one person</option>
            </Select>
          </FormField>
          <FormField label="Date" name="exc-date" error={errors.onDate}>
            <Input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} />
          </FormField>
          {kind !== "holiday" ? (
            <FormField label="Who" name="exc-who" error={errors.telecallerId}>
              <Select value={telecallerId} onChange={(e) => setTelecallerId(e.target.value)}>
                <option value="">Choose a telecaller</option>
                {people.map((p) => (
                  <option key={p.telecallerId} value={p.telecallerId}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
          <FormField label="Label (optional)" name="exc-label" error={errors.label}>
            <Input
              value={label}
              maxLength={80}
              placeholder={kind === "holiday" ? "Diwali" : ""}
              onChange={(e) => setLabel(e.target.value)}
            />
          </FormField>
          {kind === "custom_hours" ? (
            <>
              <FormField label="From" name="exc-start" error={errors.startTime} hint={timeZoneShortLabel(zone)}>
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </FormField>
              <FormField label="To" name="exc-end" error={errors.endTime} hint={timeZoneShortLabel(zone)}>
                <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </FormField>
            </>
          ) : null}
          <div className="flex items-end">
            <Button type="submit" variant="secondary" loading={pending}>
              Add
            </Button>
          </div>
        </form>
      </Card>
    </section>
  );
}
