"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useServerState } from "@/lib/use-server-state";
import Link from "next/link";
import { GripVertical, Plus, Route, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  FormField,
  Input,
  MonoLabel,
  ProgressBar,
  Select,
  StatusChip,
  useAlert,
  useConfirm,
} from "@aura/ui";
import {
  deleteWarning,
  formatPct,
  LEAD_ROUTING_STRATEGY_BLURBS,
  LEAD_ROUTING_STRATEGY_LABELS,
  LeadSourceChannel,
  sharesProblem,
  type LeadRoutingMatch,
  type LeadRoutingStrategy,
  type LeadRoutingTargetInput,
} from "@aura/shared";
import { Time } from "@/components/org-time";
import {
  backfillAction,
  createRuleAction,
  deleteRuleAction,
  resetWindowAction,
  setTargetsAction,
  updateRuleAction,
} from "./actions";
import type { RoutingOverview, RoutingRule, RoutingTarget } from "./page";

const CHANNEL_LABELS: Record<string, string> = {
  call: "Phone call",
  web_form: "Web form",
  email: "Email",
  telephony: "Telephony",
  meta_ads: "Meta ads",
  linkedin_ads: "LinkedIn ads",
  api: "API",
  import: "Import",
  manual: "Added by hand",
  whatsapp: "WhatsApp",
};

const CHANNELS = LeadSourceChannel.options;

interface RuleDraft {
  name: string;
  description: string;
  strategy: LeadRoutingStrategy;
  priority: string;
  sourceChannels: string[];
}

const BLANK: RuleDraft = {
  name: "",
  description: "",
  strategy: "round_robin",
  priority: "100",
  sourceChannels: [],
};

/**
 * The lead distribution console (migration 0105).
 *
 * ── WHAT THIS PAGE IS TRYING TO MAKE OBVIOUS ──────────────────────────────
 *
 * Three questions, in the order people actually ask them:
 *
 *   1. Who gets the next lead?      -> the "Up next" strip, straight from the
 *                                      engine's own simulation.
 *   2. Is it actually fair?         -> target vs actual, per person, with the
 *                                      drift spelled out.
 *   3. Why did Ravi get that one?   -> the decision log, in the engine's own
 *                                      words.
 *
 * A distribution rule is the one setting in this console where the customer's
 * staff have a personal stake in the answer, so every number on the page is
 * the engine's, not a re-derivation. `upNext` and `reality` are computed by
 * `@aura/shared`'s pick and share functions - the same code the API runs - and
 * a second implementation here would drift and be worse than showing nothing.
 */
export function LeadRoutingClient({ overview }: { overview: RoutingOverview }) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useServerState(overview, pending);
  const [editing, setEditing] = useState<RoutingRule | "new" | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(BLANK);
  /** Running total while a multi-batch distribution is in flight. */
  const [progress, setProgress] = useState<number | null>(null);
  const alert = useAlert();
  const confirm = useConfirm();

  useEffect(() => setState(overview), [overview]);

  const open = (rule: RoutingRule | "new") => {
    setEditing(rule);
    setDraft(
      rule === "new"
        ? BLANK
        : {
            name: rule.name,
            description: rule.description ?? "",
            strategy: rule.strategy,
            priority: String(rule.priority),
            sourceChannels: rule.match.sourceChannels ?? [],
          },
    );
  };

  const saveRule = () => {
    const name = draft.name.trim();
    if (!name) {
      void alert({ title: "Couldn't save the rule", body: "A rule needs a name", tone: "danger" });
      return;
    }
    // An empty channel list is sent as an ABSENT criterion, never as an empty
    // array. Both mean "match everything" to the engine, but only one of them
    // reads that way in the database, and a rule whose criteria look set and
    // are not is the failure this whole feature cannot afford.
    const match: LeadRoutingMatch =
      draft.sourceChannels.length > 0
        ? { sourceChannels: draft.sourceChannels as LeadRoutingMatch["sourceChannels"] }
        : {};

    const payload = {
      name,
      description: draft.description.trim() || null,
      strategy: draft.strategy,
      match,
      priority: Number(draft.priority) || 100,
      status: "active" as const,
    };

    startTransition(async () => {
      const result =
        editing === "new"
          ? await createRuleAction(payload)
          : await updateRuleAction((editing as RoutingRule).id, payload);
      if (result.error) {
        await alert({ title: "Couldn't save the rule", body: result.error, tone: "danger" });
        return;
      }
      setEditing(null);
    });
  };

  const removeRule = (rule: RoutingRule) => {
    startTransition(async () => {
      const ok = await confirm({
        title: `Delete "${rule.name}"?`,
        // Says what SURVIVES, not just what goes. The leads this rule already
        // handed out stay exactly where they are, and somebody about to delete
        // a rule is usually worried that they will not. The second sentence is
        // generated from the shared catalogue (0108) so the promised retention
        // window can never drift from the one the purge sweep enforces.
        body: `Leads it has already assigned keep their owner, and its decision history stays on this page. ${deleteWarning("lead_routing_rule")}`,
        confirmLabel: "Delete rule",
        tone: "danger",
      });
      if (!ok) return;
      const result = await deleteRuleAction(rule.id);
      if (result.error) {
        await alert({ title: "Couldn't delete the rule", body: result.error, tone: "danger" });
      }
    });
  };

  const toggleRule = (rule: RoutingRule) => {
    startTransition(async () => {
      const result = await updateRuleAction(rule.id, {
        status: rule.status === "active" ? "paused" : "active",
      });
      if (result.error) {
        await alert({ title: "Couldn't change the rule", body: result.error, tone: "danger" });
      }
    });
  };

  /**
   * Distribute the backlog, one bounded batch at a time.
   *
   * The endpoint deliberately does 25 leads and returns (see BACKFILL_LIMIT -
   * a routed lead is ~1.5s of round trips on this deployment, so a single
   * request for four hundred of them would be a gateway timeout with the
   * transaction rolled back). So the loop lives here, where it can show
   * progress and where the user can watch it move.
   *
   * It stops on three conditions, and the third is the important one: a batch
   * that assigned NOTHING means every remaining lead is being refused for a
   * reason another pass will not change - no matching rule, everyone capped -
   * and continuing would be an infinite loop against a real API.
   */
  const distribute = () => {
    startTransition(async () => {
      const ok = await confirm({
        title: `Distribute ${state.unassignedLeads} unassigned leads?`,
        body: "Each one runs through your rules exactly as a new lead would. Leads that already have an owner are never touched.",
        confirmLabel: "Distribute now",
      });
      if (!ok) return;

      let assigned = 0;
      let remaining = state.unassignedLeads;
      const reasons = new Map<string, number>();
      const MAX_BATCHES = 40;

      for (let batch = 0; batch < MAX_BATCHES && remaining > 0; batch += 1) {
        const result = await backfillAction(25);
        if (result.error || !result.data) {
          await alert({
            title: assigned > 0 ? `Stopped after ${assigned}` : "Couldn't distribute",
            body: result.error ?? "Distribution failed",
            tone: "danger",
          });
          return;
        }
        for (const s of result.data.skipped) {
          reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + s.count);
        }
        assigned += result.data.assigned;
        remaining = result.data.remaining;
        setProgress(assigned);
        // Nothing moved: every remaining lead is refused for a reason a
        // further pass cannot change.
        if (result.data.assigned === 0) break;
      }

      setProgress(null);
      const skipped = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
      await alert({
        title: `${assigned} lead${assigned === 1 ? "" : "s"} distributed`,
        // The skips matter more than the successes: "412 - no distribution
        // rule matches this lead" is the sentence that tells somebody their
        // catch-all is missing. Showing only the assigned count would hide it.
        body:
          skipped.length === 0
            ? remaining > 0
              ? `${remaining} still unassigned - run it again to continue.`
              : "Everything that could be routed has been."
            : `${skipped.map(([reason, count]) => `${count} - ${reason}`).join("; ")}.${
                remaining > 0 ? ` ${remaining} still unassigned.` : ""
              }`,
      });
    });
  };

  const rules = state.rules;

  return (
    <div className="mt-6 space-y-6">
      {/* ── The backlog ─────────────────────────────────────────────── */}
      {state.unassignedLeads > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <MonoLabel>Unassigned backlog</MonoLabel>
              <p className="mt-2 text-sm text-text-muted">
                <span className="font-medium text-text">{state.unassignedLeads}</span> open
                {state.unassignedLeads === 1 ? " lead has " : " leads have "}
                nobody working {state.unassignedLeads === 1 ? "it" : "them"}. Rules only run on
                leads as they arrive, so anything already on the board stays put until you
                distribute it.
              </p>
            </div>
            <Button
              onClick={distribute}
              disabled={pending || rules.every((r) => r.status !== "active")}
            >
              {progress === null ? "Distribute now" : `Distributed ${progress}…`}
            </Button>
          </div>
          {rules.every((r) => r.status !== "active") && (
            <p className="mt-3 text-xs text-text-muted">
              Add an active rule first - there is nothing to distribute with.
            </p>
          )}
        </Card>
      )}

      {/* ── Rules ───────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <MonoLabel>Rules, in order</MonoLabel>
        <Button size="sm" onClick={() => open("new")} disabled={pending}>
          <Plus aria-hidden className="mr-1 h-4 w-4" />
          New rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Route aria-hidden className="h-6 w-6" />}
            title="No distribution rules yet"
            description="Every lead arrives with nobody on it until somebody picks it up. A rule hands each one to a telecaller the moment it lands - in strict rotation, or by a percentage split you set."
            action={<Button onClick={() => open("new")}>Create the first rule</Button>}
          />
        </Card>
      ) : (
        rules.map((rule, index) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            order={index + 1}
            telecallers={state.telecallers}
            pending={pending}
            onEdit={() => open(rule)}
            onToggle={() => toggleRule(rule)}
            onDelete={() => removeRule(rule)}
          />
        ))
      )}

      {/* ── The decision log ────────────────────────────────────────── */}
      {state.decisions.length > 0 && (
        <Card>
          <MonoLabel>Recent decisions</MonoLabel>
          <p className="mt-2 text-xs text-text-muted">
            The engine&apos;s own reasoning, newest first. This is the answer to &ldquo;why did
            that one go to them&rdquo;.
          </p>
          <ul className="mt-4 divide-y divide-border">
            {state.decisions.map((decision) => (
              <li key={decision.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <StatusChip tone={decision.outcome === "assigned" ? "solid" : "danger"}>
                  {decision.outcome === "assigned"
                    ? (decision.telecallerName ?? "Assigned")
                    : "Unassigned"}
                </StatusChip>
                {decision.leadId && decision.leadTitle ? (
                  <Link
                    href={`/owner/leads?focus=${decision.leadId}`}
                    className="text-sm font-medium text-text underline-offset-2 hover:underline"
                  >
                    {decision.leadTitle}
                  </Link>
                ) : (
                  <span className="text-sm text-text-muted">
                    {/* The lead was erased or merged away. The decision is still
                        a true statement about what happened. */}
                    lead no longer on the board
                  </span>
                )}
                <span className="text-xs text-text-muted">{decision.reason}</span>
                <span className="ml-auto text-xs text-text-muted">
                  {decision.trigger === "backfill" ? "distributed - " : ""}
                  <Time iso={decision.createdAt} mode="datetime" />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <RuleDialog
        open={editing !== null}
        isNew={editing === "new"}
        draft={draft}
        setDraft={setDraft}
        pending={pending}
        onClose={() => setEditing(null)}
        onSave={saveRule}
      />
    </div>
  );
}

// ── one rule ────────────────────────────────────────────────────────────────

function RuleCard({
  rule,
  order,
  telecallers,
  pending,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: RoutingRule;
  order: number;
  telecallers: RoutingOverview["telecallers"];
  pending: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const paused = rule.status !== "active";
  const upNext = rule.upNext[0];
  const noLogin = rule.targets.filter((t) => !t.hasLogin).length;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <MonoLabel>#{order}</MonoLabel>
            <h3 className="text-base font-medium text-text">{rule.name}</h3>
            <StatusChip tone={paused ? "outline" : "solid"}>
              {paused ? "Paused" : "Active"}
            </StatusChip>
            <StatusChip tone="muted">{LEAD_ROUTING_STRATEGY_LABELS[rule.strategy]}</StatusChip>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">
            {rule.description || LEAD_ROUTING_STRATEGY_BLURBS[rule.strategy]}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {rule.match.sourceChannels?.length
              ? `Leads from ${rule.match.sourceChannels
                  .map((c) => CHANNEL_LABELS[c] ?? c)
                  .join(", ")}`
              : "Every lead that reaches it"}
            {" - "}
            {rule.assignedCount} assigned so far
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="secondary" onClick={onToggle} disabled={pending}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="secondary" onClick={onEdit} disabled={pending}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={pending}>
            <Trash2 aria-hidden className="h-4 w-4" />
            <span className="sr-only">Delete {rule.name}</span>
          </Button>
        </div>
      </div>

      {/* Up next - the one question everybody asks about a rotation. */}
      <div className="mt-4 rounded-md border border-border bg-surface-hover px-4 py-3">
        <MonoLabel>Up next</MonoLabel>
        {upNext?.name ? (
          <p className="mt-1 text-sm text-text">
            <span className="font-medium">{upNext.name}</span>
            <span className="text-text-muted"> - {upNext.reason}</span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-text-muted">
            Nobody. {upNext?.reason ?? "This rule has no telecallers on it."}
          </p>
        )}
        {rule.upNext.length > 1 && (
          <p className="mt-1 text-xs text-text-muted">
            then {rule.upNext.slice(1).map((d) => d.name ?? "nobody").join(", ")}
          </p>
        )}
      </div>

      <TargetEditor rule={rule} telecallers={telecallers} pending={pending} />

      {noLogin > 0 && (
        <p className="mt-3 text-xs text-text-muted">
          {noLogin === 1 ? "One telecaller" : `${noLogin} telecallers`} on this rule
          {noLogin === 1 ? " has " : " have "}
          no console login, so {noLogin === 1 ? "they" : "they"} will be assigned leads but not
          notified. Bind them to a user on the Team page.
        </p>
      )}
    </Card>
  );
}

// ── the target list ─────────────────────────────────────────────────────────

function TargetEditor({
  rule,
  telecallers,
  pending,
}: {
  rule: RoutingRule;
  telecallers: RoutingOverview["telecallers"];
  pending: boolean;
}) {
  const [rows, setRows] = useState<LeadRoutingTargetInput[]>(() => toRows(rule.targets));
  const [saving, startSaving] = useTransition();
  const alert = useAlert();
  const confirm = useConfirm();

  useEffect(() => setRows(toRows(rule.targets)), [rule.targets]);

  const dirty = useMemo(
    () => JSON.stringify(rows) !== JSON.stringify(toRows(rule.targets)),
    [rows, rule.targets],
  );

  // Live, on every keystroke, from the SAME function the API validates with -
  // so the form can never accept a split the server will reject.
  const problem = sharesProblem(rule.strategy, rows);

  const available = telecallers.filter((t) => !rows.some((r) => r.telecallerId === t.id));

  const nameOf = (id: string) =>
    rule.targets.find((t) => t.telecallerId === id)?.name ??
    telecallers.find((t) => t.id === id)?.displayName ??
    "Unknown";

  const add = (telecallerId: string) => {
    if (!telecallerId) return;
    setRows((current) => [
      ...current,
      // A new row starts at 0%, never at an invented share. Splitting the
      // remainder automatically would silently change everybody else's volume,
      // which is the edit people most need to make deliberately.
      { telecallerId, sharePct: 0, dailyCap: null, paused: false },
    ]);
  };

  const save = () => {
    startSaving(async () => {
      if (rule.strategy === "percentage" || rule.targets.length > 0) {
        const ok = await confirm({
          title: "Save this line-up?",
          // Says the thing that is genuinely surprising, before it happens.
          body: "The share counters restart from zero, so the split is measured from now on. Leads already assigned keep their owner.",
          confirmLabel: "Save line-up",
        });
        if (!ok) return;
      }
      const result = await setTargetsAction(rule.id, rows);
      if (result.error) {
        await alert({ title: "Couldn't save the line-up", body: result.error, tone: "danger" });
      }
    });
  };

  const resetWindow = () => {
    startSaving(async () => {
      const ok = await confirm({
        title: "Restart the counting?",
        body: "Everyone's delivered count goes back to zero and the split is measured from today. Nobody loses a lead they already have.",
        confirmLabel: "Restart",
      });
      if (!ok) return;
      const result = await resetWindowAction(rule.id);
      if (result.error) {
        await alert({ title: "Couldn't restart", body: result.error, tone: "danger" });
      }
    });
  };

  const busy = pending || saving;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonoLabel>Telecallers on this rule</MonoLabel>
        {rule.strategy === "round_robin" && rows.length > 1 && (
          <span className="text-xs text-text-muted">
            Order is the rotation order - top to bottom, then round again.
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          Nobody yet, so this rule assigns nothing. Add someone below.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row, index) => {
            const live = rule.targets.find((t) => t.telecallerId === row.telecallerId);
            const reality = rule.reality.find((r) => r.telecallerId === row.telecallerId);
            return (
              <li
                key={row.telecallerId}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <GripVertical aria-hidden className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-32 text-sm font-medium text-text">
                  {nameOf(row.telecallerId)}
                </span>

                {rule.strategy === "percentage" && (
                  <label className="flex items-center gap-1 text-xs text-text-muted">
                    <span className="sr-only">Share for {nameOf(row.telecallerId)}</span>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="0.1"
                      value={String(row.sharePct ?? 0)}
                      disabled={busy}
                      onChange={(e) =>
                        setRows((current) =>
                          current.map((r, i) =>
                            i === index ? { ...r, sharePct: Number(e.target.value) } : r,
                          ),
                        )
                      }
                    />
                    <span aria-hidden>%</span>
                  </label>
                )}

                <label className="flex items-center gap-1 text-xs text-text-muted">
                  <span>Daily cap</span>
                  <Input
                    type="number"
                    min={1}
                    placeholder="none"
                    value={row.dailyCap === null || row.dailyCap === undefined ? "" : String(row.dailyCap)}
                    disabled={busy}
                    onChange={(e) =>
                      setRows((current) =>
                        current.map((r, i) =>
                          i === index
                            ? { ...r, dailyCap: e.target.value === "" ? null : Number(e.target.value) }
                            : r,
                        ),
                      )
                    }
                  />
                </label>

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setRows((current) =>
                      current.map((r, i) => (i === index ? { ...r, paused: !r.paused } : r)),
                    )
                  }
                >
                  {row.paused ? "Paused" : "Active"}
                </Button>

                {/* Target vs actual. The honesty check: a rule can look
                    perfectly configured and still be handing most of the
                    volume to one person because everybody else is paused. */}
                {reality && live && (
                  <div className="ml-auto flex min-w-40 items-center gap-2">
                    <ProgressBar percent={reality.actualPct} />
                    <span className="whitespace-nowrap text-xs text-text-muted">
                      {live.delivered} - {formatPct(reality.actualPct)} of{" "}
                      {formatPct(reality.targetPct)}
                      {live.dailyCap !== null && (
                        <> - {live.assignedToday}/{live.dailyCap} today</>
                      )}
                    </span>
                  </div>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2 aria-hidden className="h-4 w-4" />
                  <span className="sr-only">Remove {nameOf(row.telecallerId)}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {problem && <p className="mt-2 text-sm text-danger">{problem}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {available.length > 0 && (
          <Select
            name={`add-${rule.id}`}
            value=""
            disabled={busy}
            onChange={(e) => add(e.target.value)}
          >
            <option value="">Add a telecaller…</option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </Select>
        )}
        {dirty && (
          <Button size="sm" onClick={save} disabled={busy || problem !== null}>
            Save line-up
          </Button>
        )}
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRows(toRows(rule.targets))}
            disabled={busy}
          >
            Discard
          </Button>
        )}
        {!dirty && rule.targets.length > 0 && (
          <Button size="sm" variant="ghost" onClick={resetWindow} disabled={busy}>
            Restart counting
          </Button>
        )}
      </div>

      {!dirty && rule.targets.length > 0 && (
        <p className="mt-2 text-xs text-text-muted">
          Counting since <Time iso={rule.windowStartedAt} mode="date" />.
        </p>
      )}
    </div>
  );
}

function toRows(targets: RoutingTarget[]): LeadRoutingTargetInput[] {
  return targets.map((t) => ({
    telecallerId: t.telecallerId,
    sharePct: t.sharePct,
    dailyCap: t.dailyCap,
    paused: t.paused,
  }));
}

// ── the rule form ───────────────────────────────────────────────────────────

function RuleDialog({
  open,
  isNew,
  draft,
  setDraft,
  pending,
  onClose,
  onSave,
}: {
  open: boolean;
  isNew: boolean;
  draft: RuleDraft;
  setDraft: (next: RuleDraft) => void;
  pending: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isNew ? "New distribution rule" : "Edit distribution rule"}
      description="Rules run in priority order and the first match wins, so put specific rules above the catch-all."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={pending}>
            {isNew ? "Create rule" : "Save rule"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label="Name" name="rule-name" required>
          <Input
            name="rule-name"
            value={draft.name}
            disabled={pending}
            placeholder="Website enquiries"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </FormField>

        <FormField
          label="How to share them out"
          name="rule-strategy"
          hint={LEAD_ROUTING_STRATEGY_BLURBS[draft.strategy]}
        >
          <Select
            name="rule-strategy"
            value={draft.strategy}
            disabled={pending}
            onChange={(e) =>
              setDraft({ ...draft, strategy: e.target.value as LeadRoutingStrategy })
            }
          >
            <option value="round_robin">{LEAD_ROUTING_STRATEGY_LABELS.round_robin}</option>
            <option value="percentage">{LEAD_ROUTING_STRATEGY_LABELS.percentage}</option>
          </Select>
        </FormField>

        <FormField
          label="Which leads"
          name="rule-channels"
          hint="Leave everything unticked to match every lead - that is how you write a catch-all."
        >
          <div className="flex flex-wrap gap-2" id="rule-channels">
            {CHANNELS.map((channel) => {
              const on = draft.sourceChannels.includes(channel);
              return (
                <label
                  key={channel}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={pending}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        sourceChannels: on
                          ? draft.sourceChannels.filter((c) => c !== channel)
                          : [...draft.sourceChannels, channel],
                      })
                    }
                  />
                  {CHANNEL_LABELS[channel] ?? channel}
                </label>
              );
            })}
          </div>
        </FormField>

        <FormField
          label="Priority"
          name="rule-priority"
          hint="Lower runs first. Leave the catch-all on a high number so specific rules win."
        >
          <Input
            name="rule-priority"
            type="number"
            min={0}
            max={1000}
            value={draft.priority}
            disabled={pending}
            onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
          />
        </FormField>

        <FormField label="Note" name="rule-description" hint="Optional - why this rule exists.">
          <Input
            name="rule-description"
            value={draft.description}
            disabled={pending}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </FormField>
      </div>
    </Dialog>
  );
}
