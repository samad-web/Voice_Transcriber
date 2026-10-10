"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Button,
  Card,
  Checkbox,
  FormField,
  Input,
  Radio,
  RadioGroup,
  StatusChip,
  buttonClasses,
} from "@aura/ui";
import {
  AlertChannel,
  WEEKDAY_NAMES,
  clockToMinute,
  minuteToClock,
  minuteToWords,
  minutesToWords,
  type CallbackPolicy,
} from "@aura/shared";
import { formatInZone } from "@/components/org-time";
import { TEXTAREA_CLASS } from "../../../agents/field-list";
import {
  saveCallbackPolicy,
  simulateCallbackPolicy,
  type SimulationOutcome,
} from "./actions";

/**
 * §10A.6's OWNER SETUP WIZARD, in the order the spec lists.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS ONE IS A WIZARD WHEN THE FEATURE PAGE IS NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The gate page next door is deliberately one screen: an owner goes there to
 * change one answer and a wizard would make them walk past four others.
 *
 * This is the opposite problem. There are forty-odd numbers here and they are
 * not independent - the calling hours decide whether the "later" rule can fit
 * today, the grace period decides when the ladder starts, the retry intervals
 * have to outlast the attempts. An owner setting them for the first time needs
 * them in an order where each answer makes the next one make sense, and then
 * needs to SEE the result before committing (step 9). That is a wizard.
 *
 * It is also why nothing saves until step 10. A per-step save would leave a
 * half-configured policy live on the floor between steps 3 and 5 - calling
 * hours changed, escalation ladder not yet - and the sweeps would act on it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  TABLET WIDTH IS THE TARGET, NOT THE FALLBACK
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §10A.6: "the wizard must be usable on tablet width." So the step rail is
 * horizontal and scrollable rather than a fixed sidebar, every field grid is
 * one column until `sm`, and the Back/Next pair is at the bottom of the step
 * where a thumb is - not in a header an owner has scrolled past.
 */

interface Step {
  key: string;
  title: string;
  /** What this step is FOR, in one line. Shown under the title. */
  blurb: string;
}

const STEPS: readonly Step[] = [
  { key: "who", title: "Who gets it", blurb: "Call-backs follow the feature switch, not a second one." },
  { key: "vague", title: "Vague requests", blurb: "What “later” and “tomorrow” mean when nobody said a time." },
  { key: "hours", title: "Calling hours", blurb: "When this business rings people, and how many calls one person can be given." },
  { key: "reminders", title: "Reminders", blurb: "How a telecaller is told a call-back has come due." },
  { key: "missed", title: "Missed and escalation", blurb: "When a call-back counts as missed, and who hears about it." },
  { key: "retries", title: "Retries", blurb: "What happens when nobody picks up." },
  { key: "reassign", title: "Reassignment", blurb: "Who takes over when the owner of a call-back cannot." },
  { key: "autocomplete", title: "Finishing by itself", blurb: "When a real call counts as the call-back being done." },
  { key: "simulate", title: "Try it", blurb: "Type what a customer might say and see exactly what would happen." },
  { key: "confirm", title: "Confirm", blurb: "Save it, and decide what happens to the call-backs already open." },
];

export function CallbackWizard({
  initial,
  timeZone,
  isDefault,
  canEdit,
}: {
  initial: CallbackPolicy;
  timeZone: string;
  /** Nothing has ever been saved - these are §18's defaults. */
  isDefault: boolean;
  canEdit: boolean;
}) {
  const [step, setStep] = useState(0);
  const [policy, setPolicy] = useState<CallbackPolicy>(initial);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ reapplied: number } | null>(null);

  const set = <K extends keyof CallbackPolicy>(key: K, value: CallbackPolicy[K]) => {
    setPolicy((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setSaved(null);
  };

  const current = STEPS[step]!;

  return (
    <div className="flex flex-col gap-4">
      {/* The rail. Scrollable rather than wrapped: ten wrapped chips on a
          tablet take four lines and push the step itself below the fold. */}
      <nav aria-label="Setup steps" className="-mx-1 overflow-x-auto px-1">
        <ol className="flex min-w-max items-center gap-1">
          {STEPS.map((item, index) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => setStep(index)}
                aria-current={index === step ? "step" : undefined}
                className={
                  index === step
                    ? "rounded-md bg-text px-2.5 py-1 text-xs font-medium text-bg"
                    : "rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text"
                }
              >
                <span className="mr-1 font-mono">{index + 1}</span>
                {item.title}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <Card>
        <div className="flex flex-col gap-4 p-4 sm:p-6">
          <header>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{current.title}</h2>
              {isDefault && !dirty ? (
                <StatusChip tone="outline">Still the built-in defaults</StatusChip>
              ) : null}
              {dirty ? <StatusChip tone="muted">Not saved yet</StatusChip> : null}
            </div>
            <p className="mt-1 max-w-prose text-sm text-text-muted">{current.blurb}</p>
          </header>

          {current.key === "who" ? <WhoStep /> : null}
          {current.key === "vague" ? <VagueStep policy={policy} set={set} /> : null}
          {current.key === "hours" ? (
            <HoursStep policy={policy} set={set} timeZone={timeZone} />
          ) : null}
          {current.key === "reminders" ? <RemindersStep policy={policy} set={set} /> : null}
          {current.key === "missed" ? <MissedStep policy={policy} set={set} /> : null}
          {current.key === "retries" ? <RetriesStep policy={policy} set={set} /> : null}
          {current.key === "reassign" ? <ReassignStep policy={policy} set={set} /> : null}
          {current.key === "autocomplete" ? (
            <AutoCompleteStep policy={policy} set={set} />
          ) : null}
          {current.key === "simulate" ? (
            <SimulateStep policy={policy} timeZone={timeZone} />
          ) : null}
          {current.key === "confirm" ? (
            <ConfirmStep
              policy={policy}
              canEdit={canEdit}
              timeZone={timeZone}
              onSaved={(reapplied) => {
                setSaved({ reapplied });
                setDirty(false);
                setError(null);
              }}
              onError={setError}
            />
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-[var(--destructive)]">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="flex items-center gap-1.5 text-sm text-text">
              <Check className="size-4" aria-hidden />
              Saved.
              {saved.reapplied > 0
                ? ` ${saved.reapplied} open call-back${saved.reapplied === 1 ? "" : "s"} moved into the new rules.`
                : " Call-backs already open keep the rules they were made under."}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={step === 0}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
            >
              <ChevronLeft className="size-4" aria-hidden /> Back
            </Button>
            <span className="text-xs text-text-muted">
              Step {step + 1} of {STEPS.length}
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={step === STEPS.length - 1}
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
            >
              Next <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}


/**
 * How each alert channel reads to an owner, and what it costs them.
 *
 * `digest` is the one worth a note: it is not a reminder at all but a summary
 * the next morning, so ticking it alone means nobody is told at the time.
 */
const CHANNEL_LABELS: Record<string, string> = {
  in_app: "In the console",
  push: "On the phone, over the lock screen",
  whatsapp: "WhatsApp to the telecaller",
  email: "Email to the telecaller",
  digest: "In the daily summary",
};

const CHANNEL_NOTES: Record<string, string | undefined> = {
  push: "Needs the Aura app installed and signed in on their handset.",
  digest: "A summary the next morning, not a reminder at the time. On its own, nobody is told while the call-back is due.",
};

type Setter = <K extends keyof CallbackPolicy>(key: K, value: CallbackPolicy[K]) => void;

/**
 * §10A.6 step 1 is not a control here, and that is the point.
 *
 * "Enable callbacks and choose which users or teams get it (VIA THE FEATURE
 * GATE)." A second switch on this page would be a second answer to "is this
 * on for Asha", and the two would drift. So this step explains and links.
 */
function WhoStep() {
  return (
    <div className="max-w-prose space-y-3 text-sm text-text-muted">
      <p>
        Call-backs are part of the call assistant, so they are on for exactly the people the
        assistant is on for. There is no separate list to keep in step.
      </p>
      <p>
        If somebody is not getting call-backs, they are not switched on for the assistant, or the
        <span className="font-medium text-text"> call-backs</span> capability is off for them.
      </p>
      <Link
        href="/owner/settings/transcript-agent"
        className={buttonClasses({ variant: "secondary", size: "sm" })}
      >
        Open the assistant&rsquo;s settings
      </Link>
    </div>
  );
}

/** §10A.6 step 2. */
function VagueStep({ policy, set }: { policy: CallbackPolicy; set: Setter }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <MinutesField
        label={"“Later” means this much later"}
        name="later-minutes"
        hint={`${minutesToWords(policy.laterMinutes)}. If that lands outside calling hours, the next working day is used instead.`}
        value={policy.laterMinutes}
        onChange={(v) => set("laterMinutes", v)}
      />
      <ClockField
        label="When it cannot fit today, ring them at"
        name="next-day-minute"
        value={policy.nextDayMinute}
        onChange={(v) => set("nextDayMinute", v)}
      />
      <ClockField
        label={"“Tomorrow” with no time means"}
        name="tomorrow-minute"
        value={policy.tomorrowMinute}
        onChange={(v) => set("tomorrowMinute", v)}
      />
      <ClockField
        label={"“Next week” with no day means Monday at"}
        name="week-minute"
        value={policy.weekMinute}
        onChange={(v) => set("weekMinute", v)}
      />
      <MinutesField
        label={"“After I speak to someone” waits"}
        name="conditional-minutes"
        hint={`${minutesToWords(policy.conditionalMinutes)}. These are never treated as a promise, so they do not escalate.`}
        value={policy.conditionalMinutes}
        onChange={(v) => set("conditionalMinutes", v)}
      />
    </div>
  );
}

/** §10A.6 step 3. */
function HoursStep({
  policy,
  set,
  timeZone,
}: {
  policy: CallbackPolicy;
  set: Setter;
  timeZone: string;
}) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-text-muted">
        All times are in this workspace&rsquo;s zone ({timeZone}). A request outside these hours is
        moved to the nearest permitted time and the telecaller is shown that it moved.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <ClockField
          label="Start ringing at"
          name="calling-start"
          value={policy.callingStartMinute}
          onChange={(v) => set("callingStartMinute", v)}
        />
        <ClockField
          label="Stop ringing at"
          name="calling-end"
          value={policy.callingEndMinute}
          onChange={(v) => set("callingEndMinute", v)}
        />
      </div>

      <fieldset className="border-0 p-0">
        <legend className="mb-2 text-sm font-medium text-text">Days this business calls</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {[1, 2, 3, 4, 5, 6, 7].map((day) => (
            <Checkbox
              key={day}
              label={WEEKDAY_NAMES[day]!}
              checked={policy.callingWeekdays.includes(day)}
              onChange={(event) =>
                set(
                  "callingWeekdays",
                  event.currentTarget.checked
                    ? [...policy.callingWeekdays, day].sort((a, b) => a - b)
                    : policy.callingWeekdays.filter((d) => d !== day),
                )
              }
            />
          ))}
        </div>
      </fieldset>

      <FormField
        label="Holidays"
        name="holidays"
        hint="One date per line, as YYYY-MM-DD. Nobody is rung on these, and a request that lands on one moves to the next working day."
      >
        <textarea
          rows={3}
          className={TEXTAREA_CLASS}
          value={policy.holidays.join("\n")}
          onChange={(event) =>
            set(
              "holidays",
              event.currentTarget.value
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => /^\d{4}-\d{2}-\d{2}$/.test(line)),
            )
          }
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          label="Most call-backs one person can be given in a day"
          name="max-per-telecaller"
          hint="0 means no limit. Over the limit, the next one goes to somebody else."
          min={0}
          max={500}
          value={policy.maxPerTelecallerPerDay}
          onChange={(v) => set("maxPerTelecallerPerDay", v)}
        />
        <NumberField
          label="Most calls to the same customer in a day"
          name="max-per-customer"
          hint="0 means no limit."
          min={0}
          max={20}
          value={policy.maxPerCustomerPerDay}
          onChange={(v) => set("maxPerCustomerPerDay", v)}
        />
        <NumberField
          label="Spread crowded call-backs this many minutes apart"
          name="cluster-spacing"
          min={1}
          max={120}
          value={policy.clusterSpacingMinutes}
          onChange={(v) => set("clusterSpacingMinutes", v)}
        />
        <NumberField
          label="…but never move a soft one more than"
          name="cluster-tolerance"
          hint="Minutes. A call-back the customer gave an exact time for is never moved to de-crowd a list."
          min={0}
          max={240}
          value={policy.clusterToleranceMinutes}
          onChange={(v) => set("clusterToleranceMinutes", v)}
        />
      </div>
    </div>
  );
}

/** §10A.6 step 4. */
function RemindersStep({ policy, set }: { policy: CallbackPolicy; set: Setter }) {
  // `AlertChannel`'s own options, not a list written here. A channel added to
  // the enum with no entry in `CHANNEL_LABELS` falls back to its key, which is
  // ugly but honest; a hard-coded list would silently hide it.
  const overrides = ["sound", "channels", "preReminderMinutes"] as const;
  const overrideLabels: Record<(typeof overrides)[number], string> = {
    sound: "Whether it makes a sound",
    channels: "Where they get it",
    preReminderMinutes: "How long before",
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          label="Remind them this many minutes before"
          name="pre-reminder"
          hint="0 turns the early reminder off; the one at the due time always fires."
          min={0}
          max={240}
          value={policy.preReminderMinutes}
          onChange={(v) => set("preReminderMinutes", v)}
        />
        <NumberField
          label="Nudge again this many minutes after"
          name="nudge"
          hint="0 turns the nudge off."
          min={0}
          max={240}
          value={policy.nudgeMinutes}
          onChange={(v) => set("nudgeMinutes", v)}
        />
      </div>

      <fieldset className="border-0 p-0">
        <legend className="mb-2 text-sm font-medium text-text">Where reminders go</legend>
        <div className="space-y-1">
          {AlertChannel.options.map((channel) => (
            <Checkbox
              key={channel}
              label={CHANNEL_LABELS[channel] ?? channel}
              description={CHANNEL_NOTES[channel]}
              checked={policy.reminderChannels.includes(channel)}
              onChange={(event) =>
                set(
                  "reminderChannels",
                  event.currentTarget.checked
                    ? [...policy.reminderChannels, channel]
                    : policy.reminderChannels.filter((c) => c !== channel),
                )
              }
            />
          ))}
        </div>
      </fieldset>

      <Checkbox
        label="Make a sound"
        description="A silent reminder on a phone in a pocket is not a reminder."
        checked={policy.sound}
        onChange={(event) => set("sound", event.currentTarget.checked)}
      />

      <FormField
        label="Snooze choices"
        name="snooze-options"
        hint="Minutes, comma separated. These are the buttons on a telecaller's list."
      >
        <Input
          value={policy.snoozeOptionsMinutes.join(", ")}
          onChange={(event) =>
            set(
              "snoozeOptionsMinutes",
              event.currentTarget.value
                .split(",")
                .map((part) => Number(part.trim()))
                .filter((n) => Number.isInteger(n) && n > 0 && n <= 24 * 60)
                .slice(0, 8),
            )
          }
        />
      </FormField>

      <fieldset className="border-0 p-0">
        <legend className="mb-1 text-sm font-medium text-text">
          What a telecaller may change for themselves
        </legend>
        <p className="mb-2 text-xs text-text-muted">
          Anything left unticked is yours alone. Whether a call-back escalates is never theirs.
        </p>
        <div className="space-y-1">
          {overrides.map((key) => (
            <Checkbox
              key={key}
              label={overrideLabels[key]}
              checked={policy.personalOverrides.includes(key)}
              onChange={(event) =>
                set(
                  "personalOverrides",
                  event.currentTarget.checked
                    ? [...policy.personalOverrides, key]
                    : policy.personalOverrides.filter((k) => k !== key),
                )
              }
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** §10A.6 step 5. */
function MissedStep({ policy, set }: { policy: CallbackPolicy; set: Setter }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          label="Minutes late before it counts as missed"
          name="grace"
          hint="An attempt that nobody answered is not a miss - that follows the retry rules instead."
          min={0}
          max={24 * 60}
          value={policy.graceMinutes}
          onChange={(v) => set("graceMinutes", v)}
        />
        <ClockField
          label="Send the daily missed-call-back digest at"
          name="digest"
          value={policy.digestMinute}
          onChange={(v) => set("digestMinute", v)}
        />
      </div>

      <Checkbox
        label="Only escalate call-backs the customer gave a time for"
        description="A vague 'call me sometime' has nobody waiting at a particular minute, so chasing a telecaller over one is noise. Turning this off escalates everything."
        checked={policy.escalateCommittedOnly}
        onChange={(event) => set("escalateCommittedOnly", event.currentTarget.checked)}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <ClockField
          label="Hold alerts from"
          name="quiet-start"
          hint="Quiet hours apply to the ALERTS, not to the call-back. A call-back due in quiet hours still shows on the list."
          value={policy.quietStartMinute}
          onChange={(v) => set("quietStartMinute", v)}
          nullable
        />
        <ClockField
          label="…until"
          name="quiet-end"
          value={policy.quietEndMinute}
          onChange={(v) => set("quietEndMinute", v)}
          nullable
        />
      </div>

      {/* The ladder is read-only here and that is a deliberate limit: a level's
          recipients are roles, positions and users resolved from the org chart,
          and a free-text editor for them on this page would need the whole
          people picker. What an owner can do here is see it and change the
          delays; who hears about it is changed where people are managed. */}
      <div>
        <p className="text-sm font-medium text-text">Escalation ladder</p>
        <p className="mt-0.5 mb-2 text-xs text-text-muted">
          Each level fires only if the one before it did not get the call-back done.
        </p>
        <ol className="space-y-2">
          {policy.ladder.map((level, index) => (
            <li key={level.level} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusChip tone="outline">Level {level.level}</StatusChip>
                <span>
                  {level.afterMinutes === 0
                    ? "straight away"
                    : `after ${minutesToWords(level.afterMinutes)}`}
                </span>
                <span className="text-text-muted">
                  {level.recipients.map((r) => describeRecipient(r)).join(", ")}
                </span>
                <StatusChip tone="muted">{describeLadderAction(level.action)}</StatusChip>
              </div>
              <div className="mt-2 max-w-48">
                <NumberField
                  label="Minutes after due"
                  name={`ladder-${level.level}`}
                  min={0}
                  max={14 * 24 * 60}
                  value={level.afterMinutes}
                  onChange={(v) =>
                    set(
                      "ladder",
                      policy.ladder.map((l, i) => (i === index ? { ...l, afterMinutes: v } : l)),
                    )
                  }
                />
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** §10A.6 step 6. */
function RetriesStep({ policy, set }: { policy: CallbackPolicy; set: Setter }) {
  return (
    <div className="space-y-4">
      <FormField
        label="Wait these long between attempts"
        name="retry-intervals"
        hint={`Minutes, comma separated, and they must not get shorter. Currently ${policy.retryIntervalsMinutes.map((m) => minutesToWords(m)).join(", then ")}.`}
      >
        <Input
          value={policy.retryIntervalsMinutes.join(", ")}
          onChange={(event) =>
            set(
              "retryIntervalsMinutes",
              event.currentTarget.value
                .split(",")
                .map((part) => Number(part.trim()))
                .filter((n) => Number.isInteger(n) && n >= 5 && n <= 14 * 24 * 60)
                .slice(0, 6),
            )
          }
        />
      </FormField>

      <NumberField
        label="Give up after this many attempts"
        name="max-attempts"
        hint="The call-back is then closed as unreachable, and that is recorded against the lead rather than lost."
        min={1}
        max={10}
        value={policy.maxAttempts}
        onChange={(v) => set("maxAttempts", v)}
      />

      <FormField
        label="Template for 'we tried to reach you'"
        name="unreachable-template"
        hint="Named, not sent. The assistant queues it for a person to approve - no message leaves this workspace without somebody saying yes. Leave it empty for no message at all."
      >
        <Input
          value={policy.unreachableTemplate ?? ""}
          onChange={(event) =>
            set("unreachableTemplate", event.currentTarget.value.trim() || null)
          }
          placeholder="e.g. callback_missed_followup"
        />
      </FormField>
    </div>
  );
}

/** §10A.6 step 7. */
function ReassignStep({ policy, set }: { policy: CallbackPolicy; set: Setter }) {
  return (
    <div className="space-y-4">
      <Checkbox
        label="Hand it on when the owner is away"
        description="Leave, off shift or outside working hours at the due time. Both people are told."
        checked={policy.reassignOnAbsence}
        onChange={(event) => set("reassignOnAbsence", event.currentTarget.checked)}
      />
      <NumberField
        label="Hand it on after this many misses"
        name="reassign-after-misses"
        hint="0 never reassigns for misses alone."
        min={0}
        max={10}
        value={policy.reassignAfterMisses}
        onChange={(v) => set("reassignAfterMisses", v)}
      />
      <RadioGroup
        legend="Who takes it"
        hint="Drawn from the org chart's reporting lines and availability."
      >
        {(["round_robin", "least_loaded", "manager"] as const).map((strategy) => (
          <Radio
            key={strategy}
            name="reassign-strategy"
            label={
              strategy === "round_robin"
                ? "The next person in the team, in turn"
                : strategy === "least_loaded"
                  ? "Whoever has the fewest call-backs that day"
                  : "Their manager"
            }
            checked={policy.reassignStrategy === strategy}
            onChange={() => set("reassignStrategy", strategy)}
          />
        ))}
      </RadioGroup>
    </div>
  );
}

/** §10A.6 step 8. */
function AutoCompleteStep({ policy, set }: { policy: CallbackPolicy; set: Setter }) {
  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-text-muted">
        When a telecaller actually rings the customer back, the call-back should close itself. The
        two numbers below decide what counts.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          label="A connected call counts if it lasted at least"
          name="autocomplete-seconds"
          hint="Seconds. Short enough and a misdial closes a promise; long enough and a quick 'yes, send it over' does not count."
          min={1}
          max={600}
          value={policy.autoCompleteSeconds}
          onChange={(v) => set("autoCompleteSeconds", v)}
        />
        <NumberField
          label="…and happened within this many minutes of the window"
          name="autocomplete-window"
          min={0}
          max={24 * 60}
          value={policy.autoCompleteWindowMinutes}
          onChange={(v) => set("autoCompleteWindowMinutes", v)}
        />
      </div>
      <Checkbox
        label="Block a calendar slot for exact-time call-backs"
        description="Only for ones the customer gave a time for. Optional, and off by default: a floor that takes thirty call-backs a day would fill a calendar with them."
        checked={policy.blockCalendarForExact}
        onChange={(event) => set("blockCalendarForExact", event.currentTarget.checked)}
      />
    </div>
  );
}

const SAMPLE_PHRASES = [
  "kal shaam 5 baje call karna",
  "call me later",
  "next week Monday",
  "after I talk to my husband",
  "please don't call me again",
];

/** §10A.6 step 9. */
function SimulateStep({ policy, timeZone }: { policy: CallbackPolicy; timeZone: string }) {
  const [text, setText] = useState(SAMPLE_PHRASES.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SimulationOutcome[] | null>(null);

  const run = async () => {
    const phrases = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (phrases.length === 0) {
      setError("Type at least one thing a customer might say.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await simulateCallbackPolicy(phrases, policy);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setResults(res.results ?? []);
  };

  return (
    <div className="space-y-4">
      <FormField
        label="What a customer might say"
        name="simulate-phrases"
        hint="One per line, in whatever language they would use. Nothing is scheduled and nothing is sent - this only shows what the rules above would do."
      >
        <textarea
          rows={5}
          className={TEXTAREA_CLASS}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </FormField>
      <Button type="button" size="sm" loading={busy} onClick={() => void run()}>
        Show me what would happen
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-[var(--destructive)]">
          {error}
        </p>
      ) : null}

      {results ? (
        <ul className="space-y-3">
          {results.map((result, index) => (
            <li key={index} className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium">&ldquo;{result.phrase}&rdquo;</p>
              {result.outcome === "not_a_callback" ? (
                <p className="mt-1 text-text-muted">{result.explanation}</p>
              ) : result.outcome === "needs_a_person" ? (
                <p className="mt-1 text-text-muted">
                  Nothing would be scheduled. {result.explanation}
                </p>
              ) : (
                <div className="mt-1 space-y-1 text-text-muted">
                  <p>
                    Rings at{" "}
                    <span className="font-medium text-text">
                      {formatInZone(result.dueAt!, "datetime", timeZone)}
                    </span>
                    {result.committed ? " — they gave this time" : " — from your default rule"}
                    {result.needsConfirmation ? ", worth confirming on the call" : ""}.
                  </p>
                  {result.moved ? (
                    <p>
                      Moved from {formatInZone(result.requestedDueAt!, "datetime", timeZone)}: {result.movedReason}
                    </p>
                  ) : null}
                  {result.reminders && result.reminders.length > 0 ? (
                    <p>
                      Reminders:{" "}
                      {result.reminders
                        .map((r) => `${reminderLabel(r.kind)} at ${formatInZone(r.at, "datetime", timeZone)}`)
                        .join(", ")}
                      .
                    </p>
                  ) : (
                    <p>No reminders — every channel is switched off.</p>
                  )}
                  {result.escalations && result.escalations.length > 0 ? (
                    <p>
                      If missed:{" "}
                      {result.escalations
                        .map(
                          (e) =>
                            `level ${e.level} at ${formatInZone(e.at, "datetime", timeZone)} (${describeLadderAction(e.action)})`,
                        )
                        .join(", ")}
                      .
                    </p>
                  ) : (
                    <p>Nobody would be escalated to — it is not a time the customer gave.</p>
                  )}
                  {result.priority ? (
                    <p>
                      Priority {result.priority.score}:{" "}
                      {result.priority.reasons.map((r) => r.factor).join(", ") || "nothing special"}.
                    </p>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** §10A.6 step 10. */
function ConfirmStep({
  policy,
  canEdit,
  timeZone,
  onSaved,
  onError,
}: {
  policy: CallbackPolicy;
  canEdit: boolean;
  timeZone: string;
  onSaved: (reapplied: number) => void;
  onError: (message: string | null) => void;
}) {
  const [reapply, setReapply] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    onError(null);
    const res = await saveCallbackPolicy({
      policy,
      reapplyToOpen: reapply,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (res.error) {
      onError(res.error);
      return;
    }
    onSaved(res.reapplied ?? 0);
  };

  return (
    <div className="space-y-4">
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <Summary label="Calling hours">
          {minuteToWords(policy.callingStartMinute)} to {minuteToWords(policy.callingEndMinute)} (
          {timeZone}), {policy.callingWeekdays.length} day
          {policy.callingWeekdays.length === 1 ? "" : "s"} a week
        </Summary>
        <Summary label={"“Later”"}>{minutesToWords(policy.laterMinutes)} on</Summary>
        <Summary label="Missed after">{minutesToWords(policy.graceMinutes)}</Summary>
        <Summary label="Escalates">
          {policy.escalateCommittedOnly ? "only times the customer gave" : "every call-back"}, through{" "}
          {policy.ladder.length} level{policy.ladder.length === 1 ? "" : "s"}
        </Summary>
        <Summary label="Retries">
          {policy.retryIntervalsMinutes.map((m) => minutesToWords(m)).join(", then ")}, up to{" "}
          {policy.maxAttempts} attempt{policy.maxAttempts === 1 ? "" : "s"}
        </Summary>
        <Summary label="Closes itself">
          a connected call of {policy.autoCompleteSeconds}s or more
        </Summary>
      </dl>

      <Checkbox
        label="Also move the call-backs already open into these rules"
        description="Only their calling hours and reminders. What the customer actually asked for is never re-read: they were told a time, and a rule change must not move it."
        checked={reapply}
        onChange={(event) => setReapply(event.currentTarget.checked)}
      />

      <FormField
        label="Why you changed it"
        name="policy-reason"
        hint="Optional, kept with the change. Useful in three months when somebody asks why the grace period is fifteen minutes."
      >
        <Input value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
      </FormField>

      {canEdit ? (
        <Button type="button" loading={busy} onClick={() => void save()}>
          Save these rules
        </Button>
      ) : (
        <p className="text-sm text-text-muted">
          You can look at these but not change them. Ask an owner or an admin.
        </p>
      )}
    </div>
  );
}

// ── small pieces ──────────────────────────────────────────────────────────

function Summary({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text">{children}</dd>
    </div>
  );
}

function ClockField({
  label,
  name,
  hint,
  value,
  onChange,
  nullable = false,
}: {
  label: string;
  name: string;
  hint?: string;
  value: number | null;
  onChange: (value: never) => void;
  nullable?: boolean;
}) {
  return (
    <FormField label={label} name={name} hint={hint}>
      <Input
        type="time"
        value={value === null ? "" : minuteToClock(value)}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          if (raw === "" && nullable) {
            onChange(null as never);
            return;
          }
          const minute = clockToMinute(raw);
          if (minute !== null) onChange(minute as never);
        }}
      />
    </FormField>
  );
}

function NumberField({
  label,
  name,
  hint,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  name: string;
  hint?: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: never) => void;
}) {
  return (
    <FormField label={label} name={name} hint={hint}>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={String(value)}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          // Out-of-range is ignored rather than clamped: clamping while
          // somebody is mid-type turns "120" into "12" the moment they pass
          // the maximum, and they cannot see why.
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next as never);
        }}
      />
    </FormField>
  );
}

function MinutesField(props: {
  label: string;
  name: string;
  hint?: string;
  value: number;
  onChange: (value: never) => void;
}) {
  return <NumberField {...props} min={15} max={14 * 24 * 60} />;
}

function describeRecipient(recipient: unknown): string {
  if (typeof recipient !== "object" || recipient === null) return String(recipient);
  const r = recipient as { kind?: string; ownerRole?: string; userId?: string };
  if (r.kind === "manager") return "their manager";
  if (r.kind === "owner") return "the owners";
  if (r.kind === "role" && r.ownerRole) return `everyone with the ${r.ownerRole} role`;
  if (r.kind === "user") return "one named person";
  if (r.kind === "position") return "whoever holds a position";
  return r.kind ?? "somebody";
}

function describeLadderAction(action: string): string {
  if (action === "reassign") return "hands it to somebody else";
  if (action === "raise_priority") return "pushes it up the list";
  return "tells them";
}

function reminderLabel(kind: string): string {
  if (kind === "pre") return "early reminder";
  if (kind === "due") return "at the due time";
  if (kind === "nudge") return "nudge";
  return kind;
}

