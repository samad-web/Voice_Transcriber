"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Link2, Users } from "lucide-react";
import {
  Button,
  Checkbox,
  Dialog,
  FormField,
  MonoLabel,
  Select,
  StatusChip,
  useAlert,
  useToast,
} from "@aura/ui";
import {
  createScheduleAction,
  deleteScheduleAction,
  publishReportAction,
  runNowAction,
  setLinkAction,
  setSharesAction,
} from "../actions";

export interface ShareRow {
  user_id: string;
  role: "owner" | "editor" | "viewer";
  name: string | null;
  email: string;
}

export interface ScheduleRow {
  id: string;
  cadence: "daily" | "weekly" | "monthly";
  day_of_week: number | null;
  day_of_month: number | null;
  hour_utc: number;
  recipients: string[];
  active: boolean;
  next_run_at: string;
  last_run_at: string | null;
}

export interface Member {
  userId: string;
  name: string | null;
  email: string;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Who can see this, who receives it, and when.
 *
 * ── THE SENTENCE THAT MATTERS ON THIS SCREEN ────────────────────────────
 *
 * A person setting up a weekly report reasonably assumes it will be emailed.
 * It will not be - Aura's third safety rule is that nothing automated sends,
 * and this feature is built to it (design doc D6). So the panel SAYS SO, on the
 * schedule form, before the button. A capability people assume they have and do
 * not is worse than one they know they lack: the first is discovered when a
 * client did not get their Monday report.
 */
export function SharePanel({
  reportId,
  open,
  onClose,
  status,
  hasLink,
  shares,
  schedules,
  members,
}: {
  reportId: string;
  open: boolean;
  onClose: () => void;
  status: "draft" | "published" | "archived";
  hasLink: boolean;
  shares: ShareRow[];
  schedules: ScheduleRow[];
  members: Member[];
}) {
  const [pending, startTransition] = useTransition();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const alert = useAlert();
  const toast = useToast();

  const [roles, setRoles] = useState<Record<string, ShareRow["role"] | "">>(() => {
    const initial: Record<string, ShareRow["role"] | ""> = {};
    for (const member of members) {
      initial[member.userId] = shares.find((s) => s.user_id === member.userId)?.role ?? "";
    }
    return initial;
  });

  const [cadence, setCadence] = useState<ScheduleRow["cadence"]>("weekly");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [hourUtc, setHourUtc] = useState(6);
  const [recipients, setRecipients] = useState<string[]>([]);

  const act = (fn: () => Promise<{ error?: string }>, success: string, failureTitle: string) => {
    startTransition(async () => {
      const result = await fn();
      if (result.error) {
        await alert({ title: failureTitle, body: result.error, tone: "danger" });
        return;
      }
      toast(success);
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share & schedule"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
      className="max-w-2xl"
    >
      <div className="space-y-5">
        {/* ── publish ─────────────────────────────────────────────────── */}
        <section>
          <MonoLabel>Publish</MonoLabel>
          <p className="mt-1 text-xs text-text-muted">
            Editing changes the draft. Publishing copies it to the version viewers and schedules
            read - so rearranging a page at four o&rsquo;clock does not change what a client is
            looking at.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                act(
                  () => publishReportAction(reportId),
                  "Published",
                  "Couldn't publish the report",
                )
              }
            >
              {status === "published" ? "Publish changes" : "Publish"}
            </Button>
            <StatusChip tone={status === "published" ? "solid" : "outline"}>{status}</StatusChip>
          </div>
        </section>

        {/* ── people ──────────────────────────────────────────────────── */}
        <section>
          <MonoLabel>
            <span className="flex items-center gap-1.5">
              <Users className="size-3.5" aria-hidden="true" />
              People
            </span>
          </MonoLabel>
          <p className="mt-1 text-xs text-text-muted">
            Viewers see the published version only. Editors can change it and export its data.
            Owners can also manage access and schedules.
          </p>
          <ul className="mt-2 max-h-52 space-y-1.5 overflow-y-auto">
            {members.map((member) => (
              <li key={member.userId} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs text-text">
                  {member.name ?? member.email}
                </span>
                <Select
                  value={roles[member.userId] ?? ""}
                  onChange={(e) =>
                    setRoles((r) => ({
                      ...r,
                      [member.userId]: e.target.value as ShareRow["role"] | "",
                    }))
                  }
                  aria-label={`Access for ${member.name ?? member.email}`}
                  className="w-32"
                >
                  <option value="">No access</option>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </Select>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={pending}
            onClick={() =>
              act(
                () =>
                  setSharesAction(
                    reportId,
                    Object.entries(roles)
                      .filter(([, role]) => role !== "")
                      .map(([userId, role]) => ({
                        userId,
                        role: role as ShareRow["role"],
                      })),
                  ),
                "Access updated",
                "Couldn't update access",
              )
            }
          >
            Save access
          </Button>
        </section>

        {/* ── link ────────────────────────────────────────────────────── */}
        <section>
          <MonoLabel>
            <span className="flex items-center gap-1.5">
              <Link2 className="size-3.5" aria-hidden="true" />
              Read-only link
            </span>
          </MonoLabel>
          <p className="mt-1 text-xs text-text-muted">
            A link anyone in this workspace can open to read the published report, without adding
            them above one at a time. It still needs a sign-in - it is not a public URL.
          </p>
          {linkToken ? (
            <input
              readOnly
              value={`${typeof window === "undefined" ? "" : window.location.origin}/owner/reports/builder/${reportId}?token=${linkToken}`}
              onFocus={(e) => e.currentTarget.select()}
              className="mt-2 w-full rounded-sm border border-border bg-bg-subtle px-2 py-1.5 font-mono text-[11px] text-text"
            />
          ) : null}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={pending || status !== "published"}
              onClick={() =>
                startTransition(async () => {
                  const result = await setLinkAction(reportId, true);
                  if (result.error) {
                    await alert({
                      title: "Couldn't create the read-only link",
                      body: result.error,
                      tone: "danger",
                    });
                    return;
                  }
                  setLinkToken(result.data?.token ?? null);
                })
              }
            >
              {hasLink || linkToken ? "Replace link" : "Create link"}
            </Button>
            {hasLink || linkToken ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await setLinkAction(reportId, false);
                    if (result.error) {
                      await alert({
                        title: "Couldn't revoke the read-only link",
                        body: result.error,
                        tone: "danger",
                      });
                      return;
                    }
                    setLinkToken(null);
                    toast("Link revoked. The old URL will no longer open.");
                  })
                }
              >
                Revoke
              </Button>
            ) : null}
          </div>
          {status !== "published" ? (
            <p className="mt-1 text-[11px] text-text-subtle">Publish the report first.</p>
          ) : null}
        </section>

        {/* ── schedule ────────────────────────────────────────────────── */}
        <section>
          <MonoLabel>
            <span className="flex items-center gap-1.5">
              <CalendarClock className="size-3.5" aria-hidden="true" />
              Scheduled delivery
            </span>
          </MonoLabel>

          {/* The honest sentence. See this file's header. */}
          <p className="mt-1 rounded-md border border-border bg-bg-subtle p-2 text-xs text-text-muted">
            On schedule, Aura runs the report, freezes the numbers, and puts it in each
            recipient&rsquo;s notifications inside this console.{" "}
            <span className="font-medium text-text">
              Nothing is emailed or sent by WhatsApp.
            </span>{" "}
            Recipients must be members of this workspace - there is nowhere to enter an outside
            address.
          </p>

          {schedules.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {schedules.map((schedule) => (
                <li
                  key={schedule.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5"
                >
                  <span className="text-xs text-text">
                    {schedule.cadence === "weekly"
                      ? `Every ${DAYS[schedule.day_of_week ?? 1]}`
                      : schedule.cadence === "monthly"
                        ? `Day ${schedule.day_of_month} each month`
                        : "Every day"}{" "}
                    at {String(schedule.hour_utc).padStart(2, "0")}:00 UTC ·{" "}
                    {schedule.recipients.length} recipient
                    {schedule.recipients.length === 1 ? "" : "s"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      act(
                        () => deleteScheduleAction(reportId, schedule.id),
                        "Schedule removed",
                        "Couldn't remove the schedule",
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <FormField label="How often" name="cadence">
              <Select
                value={cadence}
                onChange={(e) => setCadence(e.target.value as ScheduleRow["cadence"])}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </FormField>

            {cadence === "weekly" ? (
              <FormField label="Day" name="dayOfWeek">
                <Select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                  {DAYS.map((day, i) => (
                    <option key={day} value={i}>
                      {day}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : null}

            {cadence === "monthly" ? (
              <FormField
                label="Day of month"
                name="dayOfMonth"
                hint="Up to 28, so February always has it."
              >
                <Select value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : null}

            <FormField label="Hour (UTC)" name="hourUtc">
              <Select value={hourUtc} onChange={(e) => setHourUtc(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <fieldset className="mt-2">
            <legend className="text-xs font-medium text-text">Recipients</legend>
            <div className="mt-1 max-h-36 space-y-1 overflow-y-auto">
              {members.map((member) => (
                <Checkbox
                  key={member.userId}
                  checked={recipients.includes(member.userId)}
                  onChange={(e) =>
                    setRecipients((r) =>
                      e.target.checked
                        ? [...r, member.userId]
                        : r.filter((id) => id !== member.userId),
                    )
                  }
                  label={member.name ?? member.email}
                />
              ))}
            </div>
          </fieldset>

          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={pending || recipients.length === 0 || status !== "published"}
              onClick={() =>
                act(
                  () =>
                    createScheduleAction(reportId, {
                      cadence,
                      dayOfWeek: cadence === "weekly" ? dayOfWeek : null,
                      dayOfMonth: cadence === "monthly" ? dayOfMonth : null,
                      hourUtc,
                      recipients,
                    }),
                  "Schedule created",
                  "Couldn't create the schedule",
                )
              }
            >
              Add schedule
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                act(
                  () => runNowAction(reportId),
                  "Report run - see Runs",
                  "Couldn't run the report",
                )
              }
            >
              Run now
            </Button>
          </div>
          {status !== "published" ? (
            <p className="mt-1 text-[11px] text-text-subtle">
              A schedule reads the published version, so publish first.
            </p>
          ) : null}
        </section>
      </div>
    </Dialog>
  );
}
