"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { BellRing, Send } from "lucide-react";
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  FormField,
  Input,
  MonoLabel,
  Radio,
  RadioGroup,
  StatusChip,
  useToast,
} from "@aura/ui";
import { Time } from "@/components/org-time";
import { useServerState } from "@/lib/use-server-state";
import { TEXTAREA_CLASS } from "../agents/field-list";
import {
  handsetAlertsOverviewAction,
  sendHandsetMessageAction,
  type HandsetAlertsOverview,
  type HandsetDelivery,
  type SentHandsetMessage,
} from "./actions";

const BODY_MAX = 500;

/** Re-read receipts this often while a message is still on its way to somebody. */
const POLL_MS = 15_000;

const DELIVERY_LABEL: Record<HandsetDelivery, string> = {
  read: "Read",
  delivered: "On phone",
  sending: "Sending",
  not_reached: "Not reached",
  no_phone: "No phone",
};

/**
 * `not_reached` is the one red state: the message was MISSED, which is what
 * red means in this console (an error would be orange). "Sending" is outline,
 * not a fault - a phone in a pocket on mobile data collects it in seconds.
 */
const DELIVERY_TONE = {
  read: "solid",
  delivered: "muted",
  sending: "outline",
  not_reached: "danger",
  no_phone: "outline",
} as const satisfies Record<HandsetDelivery, string>;

function tally(m: SentHandsetMessage): string {
  const n = (d: HandsetDelivery) => m.recipients.filter((r) => r.delivery === d).length;
  const parts = [
    n("read") && `${n("read")} read`,
    n("delivered") && `${n("delivered")} on phone, unread`,
    n("sending") && `${n("sending")} sending`,
    n("not_reached") && `${n("not_reached")} not reached`,
    n("no_phone") && `${n("no_phone")} with no phone`,
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * "Message phones" (migration 0150): an owner or manager puts a message on the
 * team's handsets - a full-screen popup over the lock screen by default, or a
 * notification - and sees, per person, whether it arrived and was read.
 *
 * Rendered only when the overview loaded, which the API allows to owners and
 * managers alone; for anyone else the page simply has no panel.
 */
export function MessagePhones({ initial }: { initial: HandsetAlertsOverview }) {
  const [overview, setOverview] = useServerState(initial);
  const [open, setOpen] = useState(false);
  const withPhone = overview.recipients.filter((r) => r.hasPhone).length;

  const inFlight = overview.sent.some((m) => m.recipients.some((r) => r.delivery === "sending"));
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => {
      void handsetAlertsOverviewAction().then(({ overview: fresh }) => {
        if (fresh) setOverview(fresh);
      });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, setOverview]);

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 text-base font-semibold text-text">
            <BellRing className="h-4 w-4" aria-hidden />
            Message phones
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            Put a message on your telecallers&apos; phones - it pops up over the lock screen even
            when the app is closed. New leads, tasks and follow-ups reach their phones the same
            way, automatically. A phone must be switched on, online and allowed to run in the
            background to receive anything.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={withPhone === 0}>
          <Send className="h-4 w-4" aria-hidden />
          New message
        </Button>
      </div>

      {withPhone === 0 && (
        <p className="mt-3 text-sm text-text-muted">Pair a handset first - nobody has a phone to message yet.</p>
      )}

      {overview.sent.length > 0 && (
        <div className="mt-5 space-y-3">
          <MonoLabel>Sent</MonoLabel>
          <ul className="divide-y divide-border">
            {overview.sent.map((m) => (
              <SentRow key={m.batchId} message={m} />
            ))}
          </ul>
        </div>
      )}

      <ComposeDialog
        open={open}
        onClose={() => setOpen(false)}
        overview={overview}
        onSent={(fresh) => {
          if (fresh) setOverview(fresh);
          setOpen(false);
        }}
      />
    </Card>
  );
}

function SentRow({ message: m }: { message: SentHandsetMessage }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 text-sm font-medium text-text">
          {m.title}
          {!m.popup && <span className="ml-2 text-xs font-normal text-text-muted">(notification)</span>}
        </p>
        <p className="text-xs text-text-muted">
          <Time iso={m.sentAt} mode="relative" />
          {m.sentBy ? ` · ${m.sentBy}` : ""}
        </p>
      </div>
      {m.body && <p className="mt-1 line-clamp-2 break-words text-sm text-text-muted">{m.body}</p>}
      <button
        type="button"
        className="mt-1 text-xs text-text-muted underline underline-offset-2 hover:text-text"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {tally(m)}
      </button>
      {expanded && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {m.recipients.map((r) => (
            <li key={r.telecallerId}>
              <StatusChip tone={DELIVERY_TONE[r.delivery]}>
                {r.name}: {DELIVERY_LABEL[r.delivery]}
              </StatusChip>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ComposeDialog({
  open,
  onClose,
  overview,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  overview: HandsetAlertsOverview;
  onSent: (fresh: HandsetAlertsOverview | undefined) => void;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [everyone, setEveryone] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [popup, setPopup] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const withPhone = useMemo(() => overview.recipients.filter((r) => r.hasPhone), [overview.recipients]);
  const ready = body.trim().length > 0 && (everyone || picked.size > 0);

  function reset() {
    setEveryone(true);
    setPicked(new Set());
    setTitle("");
    setBody("");
    setPopup(true);
    setError(null);
  }

  function send() {
    setError(null);
    startTransition(async () => {
      const res = await sendHandsetMessageAction({
        everyone,
        telecallerIds: everyone ? [] : [...picked],
        title: title.trim() || undefined,
        body: body.trim(),
        popup,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      toast(
        `Sent to ${res.recipients} ${res.recipients === 1 ? "person" : "people"} - each status updates as their phone collects it.`,
      );
      const { overview: fresh } = await handsetAlertsOverviewAction();
      reset();
      onSent(fresh);
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Message phones"
      description="Reaches only your own team's paired phones."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={send} loading={pending} disabled={!ready || pending}>
            Send
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <RadioGroup legend="Send to">
          <Radio
            name="handset-recipients"
            label={`Everyone with a phone (${withPhone.length})`}
            checked={everyone}
            onChange={() => setEveryone(true)}
          />
          <Radio
            name="handset-recipients"
            label="Choose people"
            checked={!everyone}
            onChange={() => setEveryone(false)}
          />
        </RadioGroup>

        {!everyone && (
          <div className="max-h-56 space-y-2 overflow-y-auto rounded-sm border border-border p-3">
            {overview.recipients.map((r) => (
              <Checkbox
                key={r.telecallerId}
                label={r.name}
                description={
                  !r.hasPhone
                    ? "No paired phone"
                    : r.needsUpdate
                      ? "Phone app needs updating before it can show messages"
                      : !r.pushable
                        ? "Phone can't be woken - gets it within the hour"
                        : undefined
                }
                checked={picked.has(r.telecallerId)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.currentTarget.checked) next.add(r.telecallerId);
                  else next.delete(r.telecallerId);
                  setPicked(next);
                }}
              />
            ))}
          </div>
        )}

        <FormField label="Heading" name="handset-title" hint="Optional. Defaults to “Message from <your name>”.">
          <Input value={title} maxLength={80} onChange={(e) => setTitle(e.currentTarget.value)} />
        </FormField>

        <FormField
          label="Message"
          name="handset-body"
          required
          hint={`${body.length}/${BODY_MAX}`}
          error={error}
        >
          <textarea
            rows={4}
            className={TEXTAREA_CLASS}
            value={body}
            maxLength={BODY_MAX}
            onChange={(e) => setBody(e.currentTarget.value)}
          />
        </FormField>

        <Checkbox
          label="Pop up over the screen"
          description="Wakes the phone and covers the lock screen until they tap “Got it”. Untick to send a normal notification."
          checked={popup}
          onChange={(e) => setPopup(e.currentTarget.checked)}
        />
      </div>
    </Dialog>
  );
}
