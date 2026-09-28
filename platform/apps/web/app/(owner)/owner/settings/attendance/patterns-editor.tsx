"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  FormField,
  Input,
  MonoLabel,
  StatusChip,
  useConfirm,
  useToast,
} from "@aura/ui";
import { DEFAULT_SHIFT, ShiftPatternInput, timeZoneShortLabel } from "@aura/shared";
import { useServerState } from "@/lib/use-server-state";
import {
  WEEKDAYS,
  describeWorkDays,
  isNightShift,
  issuesByField,
  wall,
  type ShiftPattern,
} from "@/lib/attendance";
import { archivePatternAction, savePatternAction } from "./actions";

interface Draft {
  name: string;
  workDays: number[];
  startTime: string;
  endTime: string;
  graceMinutes: string;
  breakAllowanceMinutes: string;
  silenceThresholdMinutes: string;
  promptTimeoutMinutes: string;
  breaks: { label: string; startTime: string; durationMinutes: string }[];
}

const EMPTY: Draft = {
  name: "",
  workDays: [1, 2, 3, 4, 5, 6],
  startTime: "09:30",
  endTime: "18:30",
  graceMinutes: String(DEFAULT_SHIFT.graceMinutes),
  breakAllowanceMinutes: String(DEFAULT_SHIFT.breakAllowanceMinutes),
  silenceThresholdMinutes: String(DEFAULT_SHIFT.silenceThresholdMinutes),
  promptTimeoutMinutes: String(DEFAULT_SHIFT.promptTimeoutMinutes),
  breaks: [{ label: "Lunch", startTime: "13:30", durationMinutes: "45" }],
};

function draftOf(p: ShiftPattern): Draft {
  return {
    name: p.name,
    workDays: [...p.workDays],
    startTime: wall(p.startTime),
    endTime: wall(p.endTime),
    graceMinutes: String(p.graceMinutes),
    breakAllowanceMinutes: String(p.breakAllowanceMinutes),
    silenceThresholdMinutes: String(p.silenceThresholdMinutes),
    promptTimeoutMinutes: String(p.promptTimeoutMinutes),
    breaks: p.breaks.map((b) => ({
      label: b.label,
      startTime: wall(b.startTime),
      durationMinutes: String(b.durationMinutes),
    })),
  };
}

/** Numbers stay strings while typed; "" becomes NaN so the schema says "expected number". */
const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

function toInput(d: Draft) {
  return {
    name: d.name,
    workDays: d.workDays,
    startTime: d.startTime,
    endTime: d.endTime,
    graceMinutes: num(d.graceMinutes),
    breakAllowanceMinutes: num(d.breakAllowanceMinutes),
    silenceThresholdMinutes: num(d.silenceThresholdMinutes),
    promptTimeoutMinutes: num(d.promptTimeoutMinutes),
    breaks: d.breaks.map((b) => ({ label: b.label, startTime: b.startTime, durationMinutes: num(b.durationMinutes) })),
  };
}

/**
 * Shift patterns: the days and hours a group of telecallers works, their
 * breaks, and the presence-check timings (doc 33 §3.3, §6.1). Validated with
 * the shared `ShiftPatternInput` before it is sent, so every message here is
 * the one the API would give.
 */
export function PatternsEditor({ initial, zone }: { initial: ShiftPattern[]; zone: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [patterns, setPatterns] = useServerState(initial);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const zoneLabel = timeZoneShortLabel(zone);

  const open = (p: ShiftPattern | null) => {
    setErrors({});
    setError(null);
    setEditing({ id: p?.id ?? null, draft: p ? draftOf(p) : { ...EMPTY, breaks: EMPTY.breaks.map((b) => ({ ...b })) } });
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, [key]: value } } : e));

  const submit = () => {
    if (!editing) return;
    setError(null);
    const parsed = ShiftPatternInput.safeParse(toInput(editing.draft));
    if (!parsed.success) {
      setErrors(issuesByField(parsed.error.issues));
      return;
    }
    setErrors({});
    const id = editing.id;
    startTransition(async () => {
      const result = await savePatternAction(id, parsed.data);
      if (result.fieldErrors) setErrors(result.fieldErrors);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.pattern) {
        const saved = result.pattern;
        setPatterns((list) => (id ? list.map((p) => (p.id === id ? saved : p)) : [...list, saved]));
      }
      toast(id ? "Shift pattern saved" : "Shift pattern added");
      setEditing(null);
    });
  };

  const archive = async (p: ShiftPattern) => {
    const ok = await confirm({
      title: `Archive "${p.name}"?`,
      body:
        p.assignedCount > 0
          ? `${p.assignedCount} ${p.assignedCount === 1 ? "person is" : "people are"} on this pattern. Past timesheets keep it; move them to another pattern first so their shifts continue.`
          : "Past timesheets keep it; nobody is on it now.",
      confirmLabel: "Archive",
      tone: "danger",
      requireTyped: false,
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await archivePatternAction(p.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setPatterns((list) => list.filter((x) => x.id !== p.id));
      toast("Shift pattern archived");
    });
  };

  const d = editing?.draft;
  const night = d ? isNightShift(d.startTime, d.endTime) : false;

  return (
    <section aria-labelledby="att-patterns" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="att-patterns" className="text-sm font-semibold text-text">
            Shift patterns
          </h2>
          <p className="text-xs text-text-muted">Times are in {zoneLabel}, the workspace&rsquo;s clock.</p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => open(null)} disabled={pending}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          New shift pattern
        </Button>
      </div>

      {error && !editing ? <ErrorBanner>{error}</ErrorBanner> : null}

      {patterns.length === 0 ? (
        <EmptyState
          title="No shift patterns yet"
          description="Add one - for example Mon-Sat, 9:30 am to 6:30 pm with a lunch break - then assign it to people below."
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {patterns.map((p) => (
            <li key={p.id}>
              <Card className="h-full space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">{p.name}</p>
                    <p className="text-sm text-text-muted tabular-nums">
                      {describeWorkDays(p.workDays)} · {wall(p.startTime)}-{wall(p.endTime)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {isNightShift(p.startTime, p.endTime) ? <StatusChip tone="outline">Night shift</StatusChip> : null}
                    <StatusChip tone="muted">
                      {p.assignedCount} {p.assignedCount === 1 ? "person" : "people"}
                    </StatusChip>
                  </div>
                </div>
                <p className="text-xs text-text-muted tabular-nums">
                  Grace {p.graceMinutes} min · breaks {p.breakAllowanceMinutes} min a day · presence check after{" "}
                  {p.silenceThresholdMinutes} min quiet, answered within {p.promptTimeoutMinutes} min
                </p>
                {p.breaks.length > 0 ? (
                  <p className="text-xs text-text-muted tabular-nums">
                    {p.breaks.map((b) => `${b.label} ${wall(b.startTime)} (${b.durationMinutes} min)`).join(" · ")}
                  </p>
                ) : null}
                <div className="flex gap-2 pt-1">
                  <Button type="button" variant="secondary" size="sm" onClick={() => open(p)} disabled={pending}>
                    Edit
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void archive(p)} disabled={pending}>
                    Archive
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => (pending ? undefined : setEditing(null))}
        title={editing?.id ? "Edit shift pattern" : "New shift pattern"}
        dismissOnBackdrop={false}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} loading={pending}>
              Save
            </Button>
          </>
        }
      >
        {d ? (
          <div className="space-y-4">
            {error ? <ErrorBanner>{error}</ErrorBanner> : null}
            <FormField label="Name" name="pattern-name" error={errors.name} required>
              <Input value={d.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
            </FormField>

            <fieldset className="min-w-0 border-0 p-0">
              <legend className="mb-1 text-sm font-medium text-text">Work days</legend>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map(({ day, label }) => {
                  const on = d.workDays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set("workDays", on ? d.workDays.filter((x) => x !== day) : [...d.workDays, day].sort())
                      }
                      className={`h-8 w-11 rounded-md border text-xs font-medium ${
                        on ? "border-border-strong bg-text text-bg" : "border-border text-text-muted hover:text-text"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {errors.workDays ? <p role="alert" className="mt-1 text-xs font-medium text-danger-text">{errors.workDays}</p> : null}
            </fieldset>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Starts" name="pattern-start" error={errors.startTime} hint={zoneLabel}>
                <Input type="time" value={d.startTime} onChange={(e) => set("startTime", e.target.value)} />
              </FormField>
              <FormField label="Ends" name="pattern-end" error={errors.endTime} hint={zoneLabel}>
                <Input type="time" value={d.endTime} onChange={(e) => set("endTime", e.target.value)} />
              </FormField>
            </div>
            {night ? (
              <p className="text-xs text-text-muted">
                Night shift: it ends the next morning, and counts towards the day it starts.
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Grace before late (min)" name="pattern-grace" error={errors.graceMinutes}>
                <Input type="number" min={0} max={240} value={d.graceMinutes} onChange={(e) => set("graceMinutes", e.target.value)} />
              </FormField>
              <FormField label="Break allowance a day (min)" name="pattern-allowance" error={errors.breakAllowanceMinutes}>
                <Input
                  type="number"
                  min={0}
                  max={480}
                  value={d.breakAllowanceMinutes}
                  onChange={(e) => set("breakAllowanceMinutes", e.target.value)}
                />
              </FormField>
              <FormField
                label="Presence check after (min quiet)"
                name="pattern-silence"
                error={errors.silenceThresholdMinutes}
              >
                <Input
                  type="number"
                  min={3}
                  max={120}
                  value={d.silenceThresholdMinutes}
                  onChange={(e) => set("silenceThresholdMinutes", e.target.value)}
                />
              </FormField>
              <FormField label="Time to answer it (min)" name="pattern-prompt" error={errors.promptTimeoutMinutes}>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={d.promptTimeoutMinutes}
                  onChange={(e) => set("promptTimeoutMinutes", e.target.value)}
                />
              </FormField>
            </div>

            <fieldset className="min-w-0 space-y-2 border-0 p-0">
              <legend className="mb-1 text-sm font-medium text-text">Fixed breaks</legend>
              {d.breaks.length === 0 ? (
                <p className="text-xs text-text-muted">None. Breaks are then taken from the allowance.</p>
              ) : null}
              {d.breaks.map((b, i) => (
                <div key={i} className="flex items-end gap-2">
                  <FormField label="Label" name={`break-label-${i}`} className="min-w-0 flex-1">
                    <Input
                      value={b.label}
                      maxLength={60}
                      onChange={(e) =>
                        set("breaks", d.breaks.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                      }
                    />
                  </FormField>
                  <FormField label="At" name={`break-start-${i}`} className="w-28 shrink-0">
                    <Input
                      type="time"
                      value={b.startTime}
                      onChange={(e) =>
                        set("breaks", d.breaks.map((x, j) => (j === i ? { ...x, startTime: e.target.value } : x)))
                      }
                    />
                  </FormField>
                  <FormField label="Min" name={`break-min-${i}`} className="w-20 shrink-0">
                    <Input
                      type="number"
                      min={5}
                      max={240}
                      value={b.durationMinutes}
                      onChange={(e) =>
                        set(
                          "breaks",
                          d.breaks.map((x, j) => (j === i ? { ...x, durationMinutes: e.target.value } : x)),
                        )
                      }
                    />
                  </FormField>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${b.label || "break"}`}
                    onClick={() => set("breaks", d.breaks.filter((_, j) => j !== i))}
                    className="mb-0.5 px-2"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
              {errors.breaks ? <p role="alert" className="text-xs font-medium text-danger-text">{errors.breaks}</p> : null}
              {d.breaks.length < 8 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => set("breaks", [...d.breaks, { label: "", startTime: "", durationMinutes: "15" }])}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add a break
                </Button>
              ) : null}
            </fieldset>
            <MonoLabel>Changes reach phones within seconds</MonoLabel>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
