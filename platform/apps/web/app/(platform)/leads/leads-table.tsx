"use client";

import { useState, useTransition } from "react";
import { BrutalButton, Card, Input, MonoLabel, Select, StatusChip } from "@aura/ui";
import { convertLeadAction, deleteLeadsAction, type ConvertResult, type Lead } from "./actions";
import { RejectPanel } from "./reject-panel";

/**
 * The leads list, and the convert flow.
 *
 * A client component because converting is a two-step server round trip whose
 * result — a one-time enrollment key — has to stay on screen afterwards. A
 * form post that re-rendered the page would show the key once in a flash and
 * then lose it on the next navigation, and the key cannot be re-fetched.
 */
/**
 * How the funnel's own verdict reads to an operator.
 *
 * `status` is set by qualify() in packages/shared/src/funnel.ts and by the
 * convert/reject endpoints. It was returned by the API from the start and shown
 * nowhere, so a disqualified enquiry looked identical to a qualified one and the
 * only way to tell them apart was to read the budget field and re-apply the
 * rules from memory.
 *
 * "Didn't qualify" rather than "Disqualified": these are people, the operator
 * may well call them anyway, and the funnel's rules are a filter for who gets
 * offered a slot automatically — not a judgement anyone should read as final.
 */
const STATUS_LABELS: Record<string, { label: string; tone: "solid" | "muted" | "danger" }> = {
  qualified: { label: "Qualified", tone: "solid" },
  disqualified: { label: "Didn’t qualify", tone: "muted" },
  contact_captured: { label: "Didn’t finish", tone: "muted" },
  converted: { label: "Converted", tone: "solid" },
  rejected: { label: "Rejected", tone: "danger" },
};

/**
 * A booked call time, in the timezone the sales team actually works in.
 *
 * Asia/Kolkata is pinned rather than left to the browser. The slot was offered,
 * chosen and stored in the team's zone (SCHEDULER_TIMEZONE), so rendering it in
 * whatever zone the operator's laptop happens to be set to is how a 6:30 pm call
 * becomes a 1:00 pm one in the only place anybody reads it. The label is printed
 * alongside for the same reason — a time with no zone is a guess.
 */
function formatSlot(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

type Filter = "all" | "qualified" | "disqualified" | "contact_captured";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "qualified", label: "Qualified" },
  { id: "disqualified", label: "Didn’t qualify" },
  { id: "contact_captured", label: "Didn’t finish" },
];

export function LeadsTable({ initial }: { initial: Lead[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [converted, setConverted] = useState<Set<string>>(new Set());
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const [deleteNote, setDeleteNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  /**
   * Deleting is not rejecting, and the copy has to keep them apart. Rejecting
   * records a decision and messages the person; this removes the row, which is
   * what an erasure request needs and what clearing test data needs.
   */
  const runDelete = (scope: "selected" | "all", ids?: string[]) =>
    start(async () => {
      setDeleteNote(null);
      const res = await deleteLeadsAction({ scope, ids });
      if (res.error) {
        setDeleteNote(res.error);
        return;
      }
      setConfirmAll(false);
      if (scope === "all") setGone(new Set(initial.map((l) => l.id)));
      else ids?.forEach((id) => setGone((g) => new Set(g).add(id)));
      const parts = [`${res.deleted} enquiry(ies) deleted`];
      if (res.slotsReleased) parts.push(`${res.slotsReleased} booked slot(s) released`);
      if (res.orphanedCalendarEvents?.length) {
        parts.push(
          `${res.orphanedCalendarEvents.length} Google Calendar event(s) still exist and must be removed by hand`,
        );
      }
      setDeleteNote(`${parts.join(" · ")}.`);
    });

  // Filtering is client-side on purpose: the list is capped at 200 rows by the
  // API, all of them are already here, and a round trip per tab would make a
  // free switch feel like a page load.
  const present = initial.filter((l) => !gone.has(l.id));
  const visible = filter === "all" ? present : present.filter((l) => l.status === filter);

  const countFor = (id: Filter) =>
    id === "all" ? present.length : present.filter((l) => l.status === id).length;

  return (
    <div className="flex flex-col gap-3">
      {/* Each filter carries its own count, so "how many didn't qualify" is
          answered without pressing anything. A tab that would show nothing is
          disabled rather than hidden — a disappearing tab reads as a bug, and
          the zero is itself the answer to the question.

          RENDERED EVEN WHEN THERE ARE NO LEADS AT ALL. An early return used to
          replace this whole block with the empty-state card, which hid the
          filters at precisely the moment someone goes looking for them — an
          operator asking "where do I see the ones that didn't qualify?" saw no
          answer and reasonably concluded the feature was missing. Four tabs
          reading (0) say what the empty card cannot: the views exist, and they
          are empty because nothing has come in. */}
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const n = countFor(f.id);
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              disabled={n === 0 && f.id !== "all"}
              onClick={() => setFilter(f.id)}
              className={
                "h-9 rounded-md border px-3 text-sm font-medium transition-colors disabled:opacity-40 " +
                (active
                  ? "border-accent bg-accent/10 text-text"
                  : "border-border text-text-muted hover:bg-surface-hover hover:text-text")
              }
            >
              {f.label} ({n})
            </button>
          );
        })}
      </div>

      {/* Bulk delete. Two presses, and the second one names the number, because
          this is the only irreversible action on the page and the row count is
          the fact an operator needs to sanity-check before pressing it.

          Hidden when there is nothing to delete: a destructive control offering
          to remove zero rows is noise on an empty page. */}
      {present.length > 0 ? (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-subtle px-4 py-3">
        <p className="text-xs text-text-muted">
          {visible.length} enquiry{visible.length === 1 ? "" : "s"} shown. Deleting removes them
          from the database, releases any call they had booked, and cannot be undone.
        </p>
        {confirmAll ? (
          <div className="flex items-center gap-2">
            {/* The scope FOLLOWS THE FILTER. `scope: "all"` on the API means
                every enquiry in the table, not every row on screen — so with a
                filter applied it would delete the ones being looked at plus all
                the ones being hidden. Filtered views delete by explicit id
                instead, which is exactly the rows the count names. */}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                filter === "all"
                  ? runDelete("all")
                  : runDelete("selected", visible.map((l) => l.id))
              }
              className="h-9 rounded-md bg-danger px-3 text-sm font-medium text-danger-fg hover:opacity-90"
            >
              {pending
                ? "Deleting…"
                : filter === "all"
                  ? `Yes, delete all ${visible.length}`
                  : `Yes, delete these ${visible.length}`}
            </button>
            <button
              type="button"
              onClick={() => setConfirmAll(false)}
              className="h-9 rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={pending || visible.length === 0}
            onClick={() => setConfirmAll(true)}
            className="h-9 rounded-md border border-danger/40 px-3 text-sm font-medium text-danger-text hover:bg-danger/5"
          >
            {filter === "all" ? "Delete all" : "Delete these"}
          </button>
        )}
      </div>
      ) : null}

      {deleteNote ? (
        <p role="status" className="rounded-md border border-border bg-bg-subtle p-3 text-xs text-text">
          {deleteNote}
        </p>
      ) : null}

      {/* The empty state now sits UNDER the tabs rather than replacing them, and
          says which of two different situations this is: nothing has come in at
          all, or nothing matches the tab currently selected. */}
      {visible.length === 0 ? (
        <Card>
          <p className="text-sm font-medium text-text">
            {present.length === 0 ? "No enquiries yet." : "Nothing in this view."}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {present.length === 0
              ? "Submissions from the marketing site appear here as they arrive, qualified or not."
              : "Every enquiry so far falls under one of the other tabs."}
          </p>
        </Card>
      ) : null}

      {visible.map((lead) => {
        const done = converted.has(lead.id);
        const isRejected = rejected.has(lead.id);
        return (
          <Card key={lead.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-text">{lead.name}</p>
                  {/* The funnel's verdict, from the stored row. Suppressed once
                      this session has converted or rejected the lead, because
                      those chips are rendered below from local state and are
                      newer than the `status` the page was loaded with. */}
                  {!done && !isRejected && STATUS_LABELS[lead.status] ? (
                    <StatusChip tone={STATUS_LABELS[lead.status].tone}>
                      {STATUS_LABELS[lead.status].label}
                    </StatusChip>
                  ) : null}
                  {done ? <StatusChip tone="solid">Converted</StatusChip> : null}
                  {isRejected ? <StatusChip tone="danger">Rejected</StatusChip> : null}
                  {lead.wants_custom_crm === "yes" ? (
                    <StatusChip tone="muted">Wants custom CRM</StatusChip>
                  ) : null}
                  {lead.contact_attempts > 1 ? (
                    <StatusChip tone="muted">{lead.contact_attempts} enquiries</StatusChip>
                  ) : null}
                  {/* Shown for ANY lead holding a booked slot, whatever the
                      funnel decided about them. Booking is normally offered
                      only on the qualified path, so a booked call against a
                      lead that did not qualify is exactly the case an operator
                      must not miss: somebody is expecting a call. Hiding it
                      behind the qualified filter would make that invisible. */}
                  {lead.booked_starts_at ? (
                    <StatusChip tone="solid">Call {formatSlot(lead.booked_starts_at)} IST</StatusChip>
                  ) : null}
                </div>

                {/* Contact details are the reason an operator opens this page, so
                    they are plain selectable text rather than behind a drawer. */}
                <p className="mt-1 text-sm text-text-muted">
                  {lead.email} · {lead.phone_e164}
                  {lead.whatsapp_e164 && lead.whatsapp_e164 !== lead.phone_e164
                    ? ` · WhatsApp ${lead.whatsapp_e164}`
                    : ""}
                </p>

                <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-muted">
                  {(
                    [
                      ["Business", lead.business_type],
                      ["Team", lead.team_size],
                      ["Budget", lead.budget_inr],
                      ["Stage", lead.intent],
                      ["CRM", lead.crm_name ?? lead.has_crm],
                    ] as const
                  )
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="flex gap-1.5">
                        <dt className="font-medium">{k}:</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                </dl>

                {/* The join link, only when Google actually returned one. It is
                    null on every booking made while the calendar is configured
                    without domain-wide delegation, because a bare service
                    account cannot mint a Meet link — so this is absent far more
                    often than present, and an empty "Join:" label would read as
                    a broken link rather than an absent feature. */}
                {lead.booked_meeting_url ? (
                  <p className="mt-2 text-xs">
                    <a
                      href={lead.booked_meeting_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline underline-offset-2"
                    >
                      Join the call
                    </a>
                  </p>
                ) : null}
              </div>

              {!done && !isRejected ? (
                <div className="flex shrink-0 items-center gap-2">
                  {/* Reject is secondary: it is the destructive-ish option and
                      should not compete visually with the one that makes money. */}
                  <button
                    type="button"
                    onClick={() => {
                      setResult(null);
                      setOpenId(null);
                      setRejectingId(rejectingId === lead.id ? null : lead.id);
                    }}
                    className="h-10 rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-danger-text"
                  >
                    {rejectingId === lead.id ? "Cancel" : "Reject"}
                  </button>
                  {/* Per-row delete, for the single test lead or the one
                      erasure request. Plain text, not a button: it should be
                      reachable without competing with the two actions that are
                      part of the normal workflow. */}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => runDelete("selected", [lead.id])}
                    className="h-10 px-2 text-sm font-medium text-text-muted underline underline-offset-2 hover:text-danger-text"
                  >
                    Delete
                  </button>
                  <BrutalButton
                    onClick={() => {
                      setResult(null);
                      setRejectingId(null);
                      setOpenId(openId === lead.id ? null : lead.id);
                    }}
                  >
                    {openId === lead.id ? "Cancel" : "Convert to client"}
                  </BrutalButton>
                </div>
              ) : null}
            </div>

            {openId === lead.id && !done ? (
              <ConvertForm
                lead={lead}
                pending={pending}
                onSubmit={(form) =>
                  start(async () => {
                    const res = await convertLeadAction({ leadId: lead.id, ...form });
                    setResult(res);
                    // Marked converted whenever a tenant exists, even if the link
                    // step failed — the client is real either way, and offering
                    // "Convert" again would create a second one.
                    if (res.orgId) setConverted((s) => new Set(s).add(lead.id));
                  })
                }
              />
            ) : null}

            {rejectingId === lead.id ? (
              <RejectPanel lead={lead} onDone={() => setRejected((r) => new Set(r).add(lead.id))} />
            ) : null}

            {result && openId === lead.id ? <Outcome result={result} /> : null}
          </Card>
        );
      })}
    </div>
  );
}

function ConvertForm({
  lead,
  pending,
  onSubmit,
}: {
  lead: Lead;
  pending: boolean;
  onSubmit: (v: {
    orgName: string;
    consentPolicy: string;
    retentionDays: number;
    ttlMinutes: number;
    maxUses: number;
  }) => void;
}) {
  // Defaults chosen so the common case is one click: the enquirer's own name,
  // and the same retention default the product ships with.
  const [orgName, setOrgName] = useState(lead.name);
  const [retentionDays, setRetentionDays] = useState(90);
  const [consentPolicy, setConsentPolicy] = useState("tone");

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          Client name
          <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          Retention (days)
          <Input
            type="number"
            min={1}
            max={3650}
            value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text">
          Consent policy
          <Select value={consentPolicy} onChange={(e) => setConsentPolicy(e.target.value)}>
            <option value="tone">Audible tone</option>
            <option value="announcement">Spoken announcement</option>
          </Select>
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <BrutalButton
          shadow
          disabled={pending || orgName.trim().length === 0}
          onClick={() =>
            onSubmit({
              orgName: orgName.trim(),
              consentPolicy,
              retentionDays,
              // Enrollment key defaults: one handset, one hour. Short and narrow
              // on purpose — it is a bearer credential, and a wide one sitting in
              // a chat thread is the usual way these leak.
              ttlMinutes: 60,
              maxUses: 1,
            })
          }
        >
          {pending ? "Creating…" : "Create client and enrollment key"}
        </BrutalButton>
        <p className="text-xs text-text-muted">
          Creates the organization, workspace and first instance, and marks this lead converted.
        </p>
      </div>
    </div>
  );
}

function Outcome({ result }: { result: ConvertResult }) {
  if (result.error && !result.orgId) {
    return (
      <p role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger-text">
        {result.error}
      </p>
    );
  }
  return (
    <div className="mt-4 rounded-md border border-border bg-bg-subtle p-4">
      {result.error ? (
        <p role="alert" className="mb-3 text-sm font-semibold text-danger-text">
          {result.error}
        </p>
      ) : (
        <p className="mb-3 text-sm font-semibold text-text">
          {result.orgName} is provisioned.
        </p>
      )}
      <MonoLabel>Enrollment key — shown once, not recoverable</MonoLabel>
      <code className="mt-1 block break-all rounded bg-surface p-3 text-xs text-text">
        {result.adminKey}
      </code>
      <p className="mt-2 text-xs text-text-muted">
        Expires {result.expiresAt ? new Date(result.expiresAt).toLocaleString() : "shortly"} ·{" "}
        {result.maxUses} use{result.maxUses === 1 ? "" : "s"} · org {result.orgId}
      </p>
    </div>
  );
}
