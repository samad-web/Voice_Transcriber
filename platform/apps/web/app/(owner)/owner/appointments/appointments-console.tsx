"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  EmptyState,
  ErrorBanner,
  MonoLabel,
  StatusChip,
  useConfirm,
  useToast,
} from "@aura/ui";
import { useServerState } from "@/lib/use-server-state";
import type { ResourceView } from "../resources/resources-console";
import { BookAppointment } from "./book-appointment";
import { setAttendanceAction, updateAppointmentAction } from "./actions";

/** `present()` in appointments.controller.ts, as the console receives it. */
export interface AppointmentView {
  id: string;
  appointmentType: string;
  leadId: string | null;
  contactId: string | null;
  resourceId: string | null;
  assignedUserId: string | null;
  startsAt: string;
  endsAt: string;
  location: string | null;
  meetingUrl: string | null;
  status: string;
  attended: boolean | null;
  outcome: string | null;
  reminderSequence: number;
}

/**
 * 0166's six statuses over `StatusChip`'s four tones.
 *
 * Not `StateChip`: its states are CALL states and its tone is deliberately not
 * overridable, because red means MISSED in this console and orange means an
 * error. A `no_show` is tempting to paint red for exactly the wrong reason - it
 * IS the number this whole feature is pitched on - but red here would collide
 * with "missed call" on every other screen. `muted` with the word carries it.
 */
const STATUS_TONE: Record<string, "solid" | "muted" | "outline"> = {
  confirmed: "solid",
  scheduled: "outline",
  rescheduled: "outline",
  completed: "muted",
  no_show: "muted",
  cancelled: "muted",
};

const STATUS_WORD: Record<string, string> = {
  no_show: "no show",
};

/** "Thu 9 Oct" in the workspace's zone. */
function dayLabel(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

/** "14:30" in the workspace's zone. */
function timeLabel(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** YYYY-MM-DD in the workspace's zone - the grouping key. */
function dayKey(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(iso));
}

/**
 * The diary (Build docs/40 §B2).
 *
 * ── GROUPED BY DAY, NOT A CALENDAR GRID ────────────────────────────────────
 *
 * A month grid is what "diary" suggests and it is the wrong first build. A grid
 * has to decide what a 09:00-09:15 and a 09:05-09:35 look like in the same
 * cell, which is a layout problem rather than a product one, and it hides the
 * thing somebody actually opens this page for: what is next, with whom, and did
 * the last one happen. A list grouped by day answers all three and reads at
 * phone width, which a seven-column grid does not.
 *
 * ── EVERY TIME ON THIS PAGE IS IN THE WORKSPACE'S ZONE ─────────────────────
 *
 * `reporting_timezone`, the same clock every report uses, passed in from the
 * server. Not the browser's: a Dubai desk whose laptop is on IST would read
 * every slot 90 minutes early, and an appointment is the one record where that
 * is somebody standing outside a locked door.
 */
export function AppointmentsConsole({
  initial,
  timeZone,
  types,
  resources,
}: {
  initial: AppointmentView[];
  timeZone: string;
  types: string[];
  resources: ResourceView[];
}) {
  const [rows, setRows] = useServerState(initial);
  const [showCancelled, setShowCancelled] = useState(false);

  const resourceName = useMemo(() => {
    const byId = new Map(resources.map((r) => [r.id, `${r.code} · ${r.name}`]));
    return (id: string | null) => (id ? (byId.get(id) ?? "a resource") : null);
  }, [resources]);

  const days = useMemo(() => {
    const visible = showCancelled ? rows : rows.filter((r) => r.status !== "cancelled");
    const groups = new Map<string, AppointmentView[]>();
    for (const row of [...visible].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const key = dayKey(row.startsAt, timeZone);
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    return [...groups.entries()];
  }, [rows, showCancelled, timeZone]);

  const cancelledCount = rows.filter((r) => r.status === "cancelled").length;

  return (
    <div className="space-y-5">
      <BookAppointment
        types={types}
        resources={resources}
        timeZone={timeZone}
        onBooked={(appointment) => setRows((list) => [...list, appointment])}
      />

      {/* Said once, at the top, because it is the single most load-bearing fact
          about this page: booking writes down what is OWED and sends nothing.
          0166 queues the reminder rows in the same transaction; the drain that
          would deliver them does not exist, and when it does it still has to
          clear the owner's own switch. A reader who assumes the customer has
          been told is a reader who stops telling them. */}
      <Card className="space-y-1">
        <h3 className="text-sm font-semibold text-text">Reminders are not being sent</h3>
        <p className="max-w-2xl text-sm text-text-muted">
          Booking something here records the reminders it would need, but nothing is delivered
          to anyone — not WhatsApp, not email. Tell the customer yourself for now.
        </p>
      </Card>

      {cancelledCount > 0 ? (
        <label className="flex items-center gap-2 text-sm text-text-muted">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          Show {cancelledCount} cancelled
        </label>
      ) : null}

      {days.length === 0 ? (
        <EmptyState
          title="Nothing booked"
          description="Appointments from today onwards appear here, grouped by day — who it is with, what room or chair it uses, and whether they turned up."
        />
      ) : (
        days.map(([key, list]) => (
          <section key={key} className="space-y-3">
            <MonoLabel>{dayLabel(list[0]!.startsAt, timeZone)}</MonoLabel>
            {list.map((row) => (
              <AppointmentRow
                key={row.id}
                row={row}
                timeZone={timeZone}
                resourceLabel={resourceName(row.resourceId)}
                onChanged={(next) =>
                  setRows((all) => all.map((r) => (r.id === next.id ? next : r)))
                }
              />
            ))}
          </section>
        ))
      )}
    </div>
  );
}

function AppointmentRow({
  row,
  timeZone,
  resourceLabel,
  onChanged,
}: {
  row: AppointmentView;
  timeZone: string;
  resourceLabel: string | null;
  onChanged: (next: AppointmentView) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("");
  const [askOutcome, setAskOutcome] = useState<null | boolean>(null);

  const run = (work: () => Promise<{ error?: string; appointment?: unknown }>, done?: string) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.appointment) onChanged(result.appointment as AppointmentView);
      if (done) toast(done);
      router.refresh();
    });
  };

  const cancel = async () => {
    const ok = await confirm({
      title: "Cancel this appointment?",
      body: "It stays in the diary marked cancelled, so the history is kept. Nobody is told automatically — you will need to let them know.",
      confirmLabel: "Cancel it",
    });
    if (!ok) return;
    run(() => updateAppointmentAction(row.id, { status: "cancelled" }), "Appointment cancelled");
  };

  const settled = row.status === "completed" || row.status === "no_show";
  const open = row.status !== "cancelled" && !settled;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tabular-nums text-text">
              {timeLabel(row.startsAt, timeZone)}–{timeLabel(row.endsAt, timeZone)}
            </span>
            <StatusChip tone={STATUS_TONE[row.status] ?? "outline"}>
              {STATUS_WORD[row.status] ?? row.status}
            </StatusChip>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            {row.appointmentType}
            {resourceLabel ? ` · ${resourceLabel}` : ""}
            {row.location ? ` · ${row.location}` : ""}
          </p>
          {row.outcome ? (
            <p className="mt-1 max-w-2xl text-sm text-text">{row.outcome}</p>
          ) : null}
        </div>

        {row.reminderSequence > 0 ? (
          <div className="shrink-0 text-right">
            <MonoLabel>Reminders owed</MonoLabel>
            {/* "Owed", never "sent". The rows exist; the sender does not. */}
            <p className="text-sm font-semibold text-text">{row.reminderSequence}</p>
          </div>
        ) : null}
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {askOutcome !== null ? (
        <div className="space-y-2 border-t border-border pt-3">
          <MonoLabel>{askOutcome ? "How did it go?" : "Why not?"}</MonoLabel>
          <textarea
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
            rows={2}
            value={outcome}
            placeholder={askOutcome ? "Optional" : "Optional — e.g. phone switched off"}
            onChange={(e) => setOutcome(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
              disabled={pending}
              onClick={() =>
                run(
                  () => setAttendanceAction(row.id, askOutcome, outcome),
                  askOutcome ? "Marked as attended" : "Marked as a no-show",
                )
              }
            >
              Save
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted"
              disabled={pending}
              onClick={() => {
                setAskOutcome(null);
                setOutcome("");
              }}
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {open ? (
            <>
              {row.status === "scheduled" ? (
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => updateAppointmentAction(row.id, { status: "confirmed" }),
                      "Confirmed",
                    )
                  }
                >
                  Mark confirmed
                </button>
              ) : null}
              {/* Attendance, as two buttons rather than one toggle. "Did they
                  turn up" has two answers and both are a record somebody made;
                  a single switch would make one of them the default. */}
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
                disabled={pending}
                onClick={() => setAskOutcome(true)}
              >
                They came
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
                disabled={pending}
                onClick={() => setAskOutcome(false)}
              >
                No show
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-muted hover:bg-surface-muted disabled:opacity-60"
                disabled={pending}
                onClick={() => void cancel()}
              >
                Cancel
              </button>
            </>
          ) : (
            <p className="text-xs text-text-muted">
              {settled
                ? "Settled — attendance is recorded and cannot be changed from here."
                : "Cancelled."}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
