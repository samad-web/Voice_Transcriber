"use client";

import { useState, useTransition } from "react";
import {
  CRITERIA_FIELDS,
  CRITERIA_FIELD_OPTIONS,
  describeRule,
  type CriteriaCondition,
  type CriteriaField,
  type CriteriaRule,
  type FunnelCriteria,
} from "@aura/shared";
import { Card, Select, StatusChip, useAlert, useToast } from "@aura/ui";
import { saveFunnelCriteriaAction } from "./actions";

/**
 * Who counts as a qualified lead.
 *
 * ── THE MODEL, SAID OUT LOUD ON THE SCREEN ─────────────────────────────────
 *
 * A rule is conditions AND'd together; a lead qualifies if ANY rule matches.
 * That sentence is printed above the rules, because an editor that does not
 * state its own logic is one an operator has to guess at - and a wrong guess
 * here silently re-sorts every lead that arrives afterwards.
 *
 * ── NOTHING SAVES UNTIL SAVE IS PRESSED ────────────────────────────────────
 *
 * Every edit is local until then. Auto-saving a rule builder means a half-built
 * rule - one condition typed, the second not yet - is briefly the live
 * definition of a qualified lead, and any enquiry arriving in that window is
 * judged by it.
 */

const BLANK_CONDITION: CriteriaCondition = {
  field: "budget",
  operator: "at_least",
  values: ["30k_40k"],
};

function newRuleId(existing: CriteriaRule[]): string {
  for (let n = existing.length + 1; ; n++) {
    const id = `rule_${n}`;
    if (!existing.some((r) => r.id === id)) return id;
  }
}

export function CriteriaEditor({
  initial,
  updatedAt,
  updatedBy,
  loadError,
  onDirtyChange,
}: {
  initial: FunnelCriteria;
  updatedAt?: string;
  updatedBy?: string | null;
  loadError?: string;
  /**
   * Reported upwards so the tab strip can mark this panel as unsaved.
   *
   * Without it the only evidence of a pending change is on a screen the
   * operator has navigated away from - they toggle qualification off, switch to
   * Leads, and every visible signal says the funnel is still filtering.
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [criteria, setCriteria] = useState<FunnelCriteria>(initial);
  const [dirty, setDirty] = useState(false);
  const [pending, start] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const update = (next: FunnelCriteria) => {
    setCriteria(next);
    setDirty(true);
    onDirtyChange?.(true);
  };

  const patchRule = (id: string, patch: Partial<CriteriaRule>) =>
    update({
      ...criteria,
      rules: criteria.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });

  const save = () =>
    start(async () => {
      const res = await saveFunnelCriteriaAction(criteria);
      if (res.error) {
        await alert({
          title: "Couldn't save the qualification rules",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setDirty(false);
      onDirtyChange?.(false);
      toast("Saved. New enquiries are judged by these rules within a minute.");
    });

  if (loadError) {
    return (
      <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger-text">
        <p className="font-semibold">Could not load the qualification rules</p>
        <p className="mt-1">{loadError}</p>
        <p className="mt-2 text-xs text-text-muted">
          The funnel keeps working meanwhile - it falls back to the rules built into the release,
          which are the same three it has always applied.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The master switch, first, because it makes everything below moot. */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-semibold text-text">Qualify enquiries automatically</p>
            <p className="mt-1 max-w-xl text-xs text-text-muted">
              {criteria.enabled
                ? "Every enquiry is measured against the rules below. Anyone who matches none of them is marked “Didn’t qualify”."
                : "Turned off. EVERY enquiry is marked qualified, whatever they answered - the rules below are kept but not applied. Booking is open to everyone either way."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={criteria.enabled}
            onClick={() => update({ ...criteria, enabled: !criteria.enabled })}
            className={
              "h-9 shrink-0 rounded-md border px-3 text-sm font-medium transition-colors " +
              (criteria.enabled
                ? "border-accent bg-accent/10 text-text"
                : "border-border text-text-muted hover:bg-surface-hover")
            }
          >
            {criteria.enabled ? "On" : "Off"}
          </button>
        </div>
      </Card>

      <p className="text-xs text-text-muted">
        A lead qualifies if <strong className="text-text">any</strong> rule matches. Within a rule,{" "}
        <strong className="text-text">every</strong> condition must hold.
      </p>

      {criteria.rules.map((rule) => (
        <Card key={rule.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <input
              value={rule.name}
              onChange={(e) => patchRule(rule.id, { name: e.target.value })}
              aria-label="Rule name"
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text"
            />
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={rule.enabled}
                onClick={() => patchRule(rule.id, { enabled: !rule.enabled })}
                className={
                  "h-9 rounded-md border px-3 text-sm font-medium " +
                  (rule.enabled
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border text-text-muted")
                }
              >
                {rule.enabled ? "On" : "Off"}
              </button>
              <button
                type="button"
                onClick={() =>
                  update({ ...criteria, rules: criteria.rules.filter((r) => r.id !== rule.id) })
                }
                className="h-9 px-2 text-sm font-medium text-text-muted underline underline-offset-2 hover:text-danger-text"
              >
                Delete
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {rule.conditions.map((cond, i) => (
              <ConditionRow
                key={i}
                condition={cond}
                onChange={(next) =>
                  patchRule(rule.id, {
                    conditions: rule.conditions.map((c, j) => (j === i ? next : c)),
                  })
                }
                onRemove={() =>
                  patchRule(rule.id, {
                    conditions: rule.conditions.filter((_, j) => j !== i),
                  })
                }
              />
            ))}
          </div>

          <button
            type="button"
            onClick={() =>
              patchRule(rule.id, { conditions: [...rule.conditions, { ...BLANK_CONDITION }] })
            }
            className="mt-2 text-xs font-medium text-accent underline underline-offset-2"
          >
            Add a condition
          </button>

          {/* Read back as one sentence. The controls above say what each part
              is; this says what the rule MEANS, which is the thing an operator
              is actually trying to get right. */}
          <p className="mt-3 rounded-md border border-border bg-bg-subtle p-2.5 text-xs text-text-muted">
            {rule.conditions.length === 0 ? (
              <span className="text-warning-text">
                No conditions yet, so this rule never matches anybody.
              </span>
            ) : (
              describeRule(rule)
            )}
          </p>
        </Card>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() =>
            update({
              ...criteria,
              rules: [
                ...criteria.rules,
                {
                  id: newRuleId(criteria.rules),
                  name: "New rule",
                  enabled: true,
                  conditions: [{ ...BLANK_CONDITION }],
                },
              ],
            })
          }
          className="h-9 rounded-md border border-border px-3 text-sm font-medium text-text-muted hover:bg-surface-hover hover:text-text"
        >
          Add a rule
        </button>

        <button
          type="button"
          disabled={pending || !dirty}
          onClick={save}
          className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
        >
          {pending ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>

        {/* Only the enabled rules with conditions can ever fire, and an
            operator who has switched them all off should be told before they
            walk away thinking the funnel is filtering. */}
        {criteria.enabled &&
        criteria.rules.filter((r) => r.enabled && r.conditions.length > 0).length === 0 ? (
          <StatusChip tone="danger">No rule can match - everyone will be disqualified</StatusChip>
        ) : null}
      </div>

      {updatedAt ? (
        <p className="text-xs text-text-muted">
          Last changed {new Date(updatedAt).toLocaleString()}
          {updatedBy ? ` by ${updatedBy}` : ""}.
        </p>
      ) : null}
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: CriteriaCondition;
  onChange: (next: CriteriaCondition) => void;
  onRemove: () => void;
}) {
  const spec = CRITERIA_FIELD_OPTIONS[condition.field];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
      <Select
        aria-label="Question"
        value={condition.field}
        onChange={(e) => {
          const field = e.target.value as CriteriaField;
          const next = CRITERIA_FIELD_OPTIONS[field];
          // Values and operator BOTH reset with the question. Keeping either
          // would leave a condition referring to answers the new question does
          // not have - which the validator rejects on save, after the operator
          // has forgotten what they changed.
          onChange({
            field,
            operator: next.ordered ? "at_least" : "is_one_of",
            values: [next.options[0]!.value],
          });
        }}
        className="min-w-[13rem] flex-1"
      >
        {CRITERIA_FIELDS.map((f) => (
          <option key={f} value={f}>
            {CRITERIA_FIELD_OPTIONS[f].label}
          </option>
        ))}
      </Select>

      {/* "at least" is offered only where the answers have an order. Budget is
          the only one today; offering it elsewhere would let somebody write
          "business type is at least Healthcare". */}
      <Select
        aria-label="Comparison"
        value={condition.operator}
        onChange={(e) =>
          onChange({
            ...condition,
            operator: e.target.value as CriteriaCondition["operator"],
            values: [condition.values[0] ?? spec.options[0]!.value],
          })
        }
        className="w-32"
        disabled={!spec.ordered}
      >
        <option value="is_one_of">is</option>
        {spec.ordered ? <option value="at_least">is at least</option> : null}
      </Select>

      {condition.operator === "at_least" ? (
        <Select
          aria-label="Answer"
          value={condition.values[0] ?? ""}
          onChange={(e) => onChange({ ...condition, values: [e.target.value] })}
          className="min-w-[12rem] flex-1"
        >
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <div className="flex flex-1 flex-wrap gap-1.5">
          {spec.options.map((o) => {
            const on = condition.values.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange({
                    ...condition,
                    values: on
                      ? condition.values.filter((v) => v !== o.value)
                      : [...condition.values, o.value],
                  })
                }
                className={
                  "rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors " +
                  (on
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border text-text-muted hover:bg-surface-hover")
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove condition"
        className="h-8 px-2 text-xs font-medium text-text-muted underline underline-offset-2 hover:text-danger-text"
      >
        Remove
      </button>
    </div>
  );
}
