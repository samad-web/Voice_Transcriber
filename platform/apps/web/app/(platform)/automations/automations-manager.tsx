"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Card,
  FormField,
  Input,
  MonoLabel,
  Select,
  StatusChip,
  useAlert,
} from "@aura/ui";
import {
  createAutomationAction,
  deleteAutomationAction,
  updateAutomationAction,
  type AutomationRule,
  type AutomationRun,
} from "./actions";

/**
 * Define what happens automatically (PRD Layer 2).
 *
 * ── THE FORM IS DELIBERATELY NOT A RULE BUILDER ───────────────────────────
 *
 * One trigger, a couple of optional conditions and one action per rule. A
 * full visual builder - nested AND/OR groups, branches, a canvas - is what
 * this grows into if it earns it, and building that before anybody has
 * written a single rule would be guessing at which shapes people need. Two
 * rules chained by hand are easier to read than one rule with a tree in it,
 * and this way the JSON stays something an operator can be shown.
 *
 * The run log sits underneath rather than behind a tab, because "why didn't
 * my rule fire?" is the first question anybody asks and non-matches are
 * recorded specifically so it has an answer.
 */

const TRIGGER_LABELS: Record<string, string> = {
  "deal.created": "A deal is created",
  "deal.stage_changed": "A deal changes stage",
  "deal.idle": "A deal goes quiet",
  "task.overdue": "A task goes overdue",
  "interaction.logged": "Something lands on a timeline",
  "contact.created": "A contact is created",
};

const ACTION_LABELS: Record<string, string> = {
  create_task: "Create a follow-up task",
  notify: "Notify someone in the console",
  add_note: "Add a note to the timeline",
};

type Draft = {
  name: string;
  trigger: string;
  toStage: string;
  idleDays: string;
  amountGte: string;
  actionType: string;
  actionText: string;
  dueInDays: string;
};

const EMPTY: Draft = {
  name: "",
  trigger: "deal.stage_changed",
  toStage: "",
  idleDays: "",
  amountGte: "",
  actionType: "create_task",
  actionText: "",
  dueInDays: "1",
};

export function AutomationsManager({
  orgId,
  rules,
  triggers,
  sweepTriggers,
  runs,
}: {
  orgId: string;
  rules: AutomationRule[];
  triggers: string[];
  sweepTriggers: string[];
  runs: AutomationRun[];
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const isSweep = sweepTriggers.includes(draft.trigger);

  const submit = () => {
    if (!draft.name.trim() || !draft.actionText.trim()) {
      void alert({
        title: "The rule needs a name and an action",
        body: "Give it a name, and say what it should do when the trigger fires.",
        tone: "danger",
      });
      return;
    }

    const conditions: Record<string, unknown> = {};
    if (draft.trigger === "deal.stage_changed" && draft.toStage.trim()) {
      conditions.toStage = draft.toStage.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (isSweep && draft.idleDays.trim()) conditions.idleDays = Number(draft.idleDays);
    if (draft.amountGte.trim()) conditions.amountGte = Number(draft.amountGte);

    const action =
      draft.actionType === "create_task"
        ? {
            type: "create_task",
            title: draft.actionText.trim(),
            dueInDays: Number(draft.dueInDays) || 0,
          }
        : draft.actionType === "notify"
          ? { type: "notify", title: draft.actionText.trim() }
          : { type: "add_note", body: draft.actionText.trim() };

    startTransition(async () => {
      const result = await createAutomationAction({
        orgId,
        name: draft.name.trim(),
        trigger: draft.trigger,
        conditions,
        actions: [action],
      });
      if (result.error) {
        await alert({
          title: "Couldn't create the rule",
          body: result.error,
          tone: "danger",
        });
        return;
      }
      setDraft(EMPTY);
    });
  };

  const toggle = (rule: AutomationRule) => {
    const paused = rule.status === "active";
    startTransition(async () => {
      const result = await updateAutomationAction(rule.id, {
        orgId,
        status: paused ? "paused" : "active",
      });
      if (result.error) {
        await alert({
          title: paused ? "Couldn't pause the rule" : "Couldn't resume the rule",
          body: result.error,
          tone: "danger",
        });
      }
    });
  };

  const remove = (rule: AutomationRule) => {
    startTransition(async () => {
      const result = await deleteAutomationAction(rule.id, orgId);
      if (result.error) {
        await alert({
          title: "Couldn't delete the rule",
          body: result.error,
          tone: "danger",
        });
      }
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <MonoLabel>New rule</MonoLabel>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <FormField label="Name" name="rule-name">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Chase deals that reach Negotiation"
            />
          </FormField>

          <FormField label="When" name="rule-trigger">
            <Select
              value={draft.trigger}
              onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
            >
              {triggers.map((trigger) => (
                <option key={trigger} value={trigger}>
                  {TRIGGER_LABELS[trigger] ?? trigger}
                </option>
              ))}
            </Select>
          </FormField>

          {draft.trigger === "deal.stage_changed" ? (
            <FormField label="Only into these stages (optional)" name="rule-to-stage">
              <Input
                value={draft.toStage}
                onChange={(e) => setDraft({ ...draft, toStage: e.target.value })}
                placeholder="negotiation, won"
              />
            </FormField>
          ) : null}

          {isSweep ? (
            <FormField label="After this many days" name="rule-idle-days">
              <Input
                type="number"
                min={1}
                value={draft.idleDays}
                onChange={(e) => setDraft({ ...draft, idleDays: e.target.value })}
                placeholder="14"
              />
            </FormField>
          ) : null}

          <FormField label="Only if the amount is at least (optional)" name="rule-amount">
            <Input
              type="number"
              min={0}
              value={draft.amountGte}
              onChange={(e) => setDraft({ ...draft, amountGte: e.target.value })}
              placeholder="-"
            />
          </FormField>

          <FormField label="Then" name="rule-action">
            <Select
              value={draft.actionType}
              onChange={(e) => setDraft({ ...draft, actionType: e.target.value })}
            >
              {Object.entries(ACTION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField
            label={draft.actionType === "add_note" ? "Note" : "Title"}
            name="rule-action-text"
          >
            <Input
              value={draft.actionText}
              onChange={(e) => setDraft({ ...draft, actionText: e.target.value })}
              placeholder="Call them about the quote"
            />
          </FormField>

          {draft.actionType === "create_task" ? (
            <FormField label="Due in (days)" name="rule-due">
              <Input
                type="number"
                min={0}
                value={draft.dueInDays}
                onChange={(e) => setDraft({ ...draft, dueInDays: e.target.value })}
              />
            </FormField>
          ) : null}
        </div>

        <p className="mt-3 text-xs text-text-muted">
          Rules cannot send email. Everything they do stays inside the console and can be undone.
        </p>

        <div className="mt-3">
          <Button type="button" onClick={submit} loading={pending}>
            Create rule
          </Button>
        </div>
      </Card>

      <Card>
        <MonoLabel>Rules</MonoLabel>
        {rules.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">Nothing automated yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-text">{rule.name}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    {TRIGGER_LABELS[rule.trigger] ?? rule.trigger} →{" "}
                    {rule.actions
                      .map((a) => ACTION_LABELS[String(a.type)] ?? String(a.type))
                      .join(", ")}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-subtle tabular-nums">
                    {/* Run count answers the only question an operator has
                        about a rule they cannot see working. */}
                    fired {rule.run_count} time{Number(rule.run_count) === 1 ? "" : "s"}
                    {rule.last_run_at
                      ? ` · last ${new Date(rule.last_run_at).toLocaleString()}`
                      : ""}
                  </span>
                </div>
                <StatusChip tone={rule.status === "active" ? "solid" : "muted"}>
                  {rule.status}
                </StatusChip>
                <Button type="button" variant="ghost" size="sm" onClick={() => toggle(rule)}>
                  {rule.status === "active" ? "Pause" : "Resume"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => remove(rule)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <MonoLabel>Recent activity</MonoLabel>
        <p className="mt-1 text-xs text-text-muted">
          Includes rules that were considered and did <em>not</em> match - which is what makes
          &ldquo;why didn&rsquo;t my rule fire?&rdquo; answerable.
        </p>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">The engine has not run anything yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {runs.map((run) => (
              <li key={run.id} className="flex items-start gap-3 px-3 py-2">
                <StatusChip tone={run.matched ? "solid" : "muted"}>
                  {run.matched ? "fired" : "no match"}
                </StatusChip>
                <div className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-text">{run.rule_name}</span>
                  <span className="block text-xs text-text-muted">
                    {run.subject_type} · {new Date(run.created_at).toLocaleString()}
                  </span>
                  {run.outcome.length > 0 ? (
                    <span className="mt-0.5 block text-xs text-text-subtle">
                      {run.outcome
                        .map((o) => `${o.type}: ${o.ok ? "ok" : (o.detail ?? "failed")}`)
                        .join(" · ")}
                    </span>
                  ) : null}
                  {run.error ? (
                    <span className="mt-0.5 block text-xs text-danger-text">{run.error}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
