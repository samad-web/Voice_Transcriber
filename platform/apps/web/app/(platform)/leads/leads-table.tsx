"use client";

import { useState, useTransition } from "react";
import { BrutalButton, Card, Input, MonoLabel, Select, StatusChip } from "@aura/ui";
import { convertLeadAction, type ConvertResult, type Lead } from "./actions";
import { RejectPanel } from "./reject-panel";

/**
 * The leads list, and the convert flow.
 *
 * A client component because converting is a two-step server round trip whose
 * result — a one-time enrollment key — has to stay on screen afterwards. A
 * form post that re-rendered the page would show the key once in a flash and
 * then lose it on the next navigation, and the key cannot be re-fetched.
 */
export function LeadsTable({ initial }: { initial: Lead[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [converted, setConverted] = useState<Set<string>>(new Set());
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  if (initial.length === 0) {
    return (
      <Card>
        <p className="text-sm font-medium text-text">No open enquiries.</p>
        <p className="mt-1 text-xs text-text-muted">
          New submissions from the marketing site appear here as they arrive.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {initial.map((lead) => {
        const done = converted.has(lead.id);
        const isRejected = rejected.has(lead.id);
        return (
          <Card key={lead.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-text">{lead.name}</p>
                  {done ? <StatusChip tone="solid">Converted</StatusChip> : null}
                  {isRejected ? <StatusChip tone="danger">Rejected</StatusChip> : null}
                  {lead.wants_custom_crm === "yes" ? (
                    <StatusChip tone="muted">Wants custom CRM</StatusChip>
                  ) : null}
                  {lead.contact_attempts > 1 ? (
                    <StatusChip tone="muted">{lead.contact_attempts} enquiries</StatusChip>
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
