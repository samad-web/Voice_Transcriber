"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  CalendarClock,
  GitCommitHorizontal,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  StickyNote,
} from "lucide-react";
import { Button, ErrorBanner, MonoLabel, StateChip, callState } from "@aura/ui";
import {
  INTERACTION_LIMIT_MAX,
  interactionToActivity,
  mergeActivity,
  type ActivityChannel,
  type ActivityItem,
  type ActorKind,
} from "@/lib/activity";
import type { ContactActivity as ContactActivityData } from "@/lib/crm-activity";
import { fetchContactActivityAction } from "./activity-actions";
import { ActorAvatar, ActorKindLabel } from "./actor-badge";
import { LogActivityForm } from "./log-activity-form";
import { relativeTime } from "./types";

const CHANNEL_ICON: Record<ActivityChannel, typeof Phone> = {
  call: Phone,
  email: Mail,
  sms: MessageSquare,
  whatsapp: MessageCircle,
  meeting: CalendarClock,
  note: StickyNote,
  stage: GitCommitHorizontal,
};

const CHANNEL_FILTERS: { key: ActivityChannel | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "call", label: "Calls" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "meeting", label: "Meetings" },
  { key: "note", label: "Notes" },
  { key: "stage", label: "Stage changes" },
];

const ACTOR_FILTERS: { key: ActorKind | "all"; label: string }[] = [
  { key: "all", label: "Everyone" },
  { key: "human", label: "Team" },
  { key: "contact", label: "Customer" },
  { key: "automated", label: "Automated" },
];

const NOUN: Record<ActivityChannel, string> = {
  call: "calls",
  email: "email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  meeting: "meetings",
  note: "notes",
  stage: "stage changes",
};

function duration(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Everything that has happened with one person, in one scrolling list:
 * calls, WhatsApp, SMS, email, meetings, notes and the stage moves of their
 * deals - with each row saying whether a teammate, an automation or the
 * customer did it (lib/activity.ts).
 *
 * One list, not tabs. The filters narrow the same list in place, so "what
 * happened last week" never means clicking through five panels, and the
 * person reading it always knows everything else is one tap away.
 *
 * Seeded from the server render (no loading flash on the core of the page),
 * then refreshed from the same composed source after something is logged.
 */
export function ContactActivity({
  contactId,
  contactName,
  initial,
}: {
  contactId: string;
  contactName: string;
  initial: ContactActivityData;
}) {
  const [feed, setFeed] = useState(initial);
  const [channel, setChannel] = useState<ActivityChannel | "all">("all");
  const [actorKind, setActorKind] = useState<ActorKind | "all">("all");
  const [composing, setComposing] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  /**
   * How much history is loaded. The first render is the server's default;
   * "Show older" asks for the API's maximum, which is as far as one composed
   * feed can honestly reach (lib/crm-activity.ts).
   */
  const [limit, setLimit] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const present = useMemo(() => new Set(feed.items.map((i) => i.channel)), [feed.items]);
  const visible = feed.items.filter(
    (item) => (channel === "all" || item.channel === channel) && (actorKind === "all" || item.actor.kind === actorKind),
  );

  const refresh = (interactionLimit = limit) =>
    startRefresh(async () => {
      const next = await fetchContactActivityAction(contactId, contactName, interactionLimit);
      if (!next.error) {
        setFeed(next);
        setLimit(interactionLimit);
      }
    });

  // 40px on a phone, 28px beside a cursor - the same thumb rule task-row.tsx
  // applies to its log buttons.
  const chip = (active: boolean) =>
    `inline-flex h-10 items-center rounded-full border px-4 text-sm font-medium sm:h-7 sm:px-3 sm:text-xs transition-colors duration-150 ease-out ${
      active
        ? "border-transparent bg-text text-bg"
        : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
    }`;

  return (
    <section aria-labelledby="contact-activity-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonoLabel>
          <span id="contact-activity-heading">Activity</span>
        </MonoLabel>
        <Button type="button" variant="ghost" size="sm" onClick={() => setComposing((v) => !v)}>
          {composing ? "Close" : "Log activity"}
        </Button>
      </div>

      {composing ? (
        <LogActivityForm
          parent="contacts"
          parentId={contactId}
          onCancel={() => setComposing(false)}
          onLogged={(interaction) => {
            // Show it at once, then reconcile with the composed feed.
            setFeed((prev) => ({
              ...prev,
              items: mergeActivity([interactionToActivity(interaction, { contactName })], prev.items),
            }));
            setComposing(false);
            refresh();
          }}
        />
      ) : null}

      <div className="space-y-2">
        <div role="group" aria-label="Filter by channel" className="flex flex-wrap gap-1.5">
          {CHANNEL_FILTERS.filter((f) => f.key === "all" || present.has(f.key)).map((f) => (
            <button key={f.key} type="button" aria-pressed={channel === f.key} onClick={() => setChannel(f.key)} className={chip(channel === f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Filter by who acted" className="flex flex-wrap gap-1.5">
          {ACTOR_FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={actorKind === f.key} onClick={() => setActorKind(f.key)} className={chip(actorKind === f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {feed.unavailable.length > 0 ? (
        <ErrorBanner>
          Couldn’t load {feed.unavailable.map((c) => NOUN[c]).join(", ")} right now - this history may be incomplete.
        </ErrorBanner>
      ) : null}

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
          {feed.items.length === 0 ? "Nothing has happened with this contact yet." : "Nothing matches these filters."}
        </p>
      ) : (
        <ol aria-busy={refreshing} className="relative space-y-0">
          {visible.map((item, index) => (
            <ActivityRow
              key={item.key}
              item={item}
              last={index === visible.length - 1}
              expanded={expanded.has(item.key)}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(item.key)) next.delete(item.key);
                  else next.add(item.key);
                  return next;
                })
              }
            />
          ))}
        </ol>
      )}

      {feed.truncated ? (
        limit === INTERACTION_LIMIT_MAX ? (
          <p className="text-xs text-text-muted">
            Showing the most recent {INTERACTION_LIMIT_MAX} logged activities - this contact has
            older history than one timeline can hold.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={refreshing}
              onClick={() => refresh(INTERACTION_LIMIT_MAX)}
            >
              Show older activity
            </Button>
            <p className="text-xs text-text-muted">Showing the most recent 100.</p>
          </div>
        )
      ) : null}
    </section>
  );
}

function ActivityRow({
  item,
  last,
  expanded,
  onToggle,
}: {
  item: ActivityItem;
  last: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = CHANNEL_ICON[item.channel];
  const length = duration(item.durationS);
  const long = (item.body?.length ?? 0) > 220;
  const automated = item.actor.kind === "automated";

  return (
    <li className="relative flex gap-3 pb-4">
      {/* The rail joining one row to the next - a timeline, read top to bottom. */}
      {last ? null : <span aria-hidden="true" className="absolute top-9 bottom-0 left-4 w-px bg-border" />}
      <ActorAvatar actor={item.actor} />
      <div
        className={`min-w-0 flex-1 rounded-md border px-3 py-2 ${
          automated ? "border-dashed border-border-strong bg-transparent" : "border-border bg-surface"
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-text">
            <ActorKindLabel actor={item.actor} />
            <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <span className={automated ? "text-text-muted" : "font-medium"}>{item.summary}</span>
          </p>
          <time dateTime={item.occurredAt} title={item.occurredAt} className="shrink-0 text-xs text-text-muted tabular-nums">
            {relativeTime(item.occurredAt)}
          </time>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          {item.channel === "call" ? (
            <StateChip state={callState({ direction: item.direction, duration_s: item.durationS })} />
          ) : null}
          {length ? <span className="tabular-nums">{length}</span> : null}
          {item.actor.via ? <span>{item.actor.via}</span> : null}
          {item.dealId && item.dealName ? (
            <Link href={`/owner/deals?focus=${item.dealId}`} className="rounded-full border border-border px-2 py-px hover:bg-surface-hover hover:text-text">
              {item.dealName}
            </Link>
          ) : null}
        </div>

        {item.subject ? <p className="mt-1.5 text-sm font-medium break-words text-text">{item.subject}</p> : null}
        {item.body ? (
          <>
            <p className={`mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-text-muted ${long && !expanded ? "line-clamp-3" : ""}`}>
              {item.body}
            </p>
            {long ? (
              <button type="button" onClick={onToggle} className="mt-1 text-xs font-medium text-accent-text hover:underline" aria-expanded={expanded}>
                {expanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}
