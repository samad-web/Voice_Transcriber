"use client";

import { describeLeadRules } from "@aura/shared";
import { Input, Label, Select } from "@aura/ui";
import {
  definitionFrom,
  type EditorLeadRules,
  type EditorState,
  type LeadRole,
  mintKeys,
} from "@/lib/agent-studio";

const ROLE_LABELS: Record<LeadRole, string> = {
  none: "Nice to have",
  required: "Must be found",
  any: "One of these is enough",
};

/**
 * When a call becomes a lead.
 *
 * Every rule here is a filter, and a filter that is too tight does not raise
 * an error - the board simply stops filling. So the panel always ends in a
 * plain sentence of what the rules add up to, and the test panel below says,
 * for a real call, whether it would have made it through.
 */
export function LeadRulesPanel({
  state,
  onChange,
}: {
  state: EditorState;
  onChange: (rules: EditorLeadRules) => void;
}) {
  const rules = state.leadRules;
  const set = (patch: Partial<EditorLeadRules>) => onChange({ ...rules, ...patch });

  const named = state.fields.filter((f) => f.name.trim() || f.key);
  const numbers = named.filter((f) => f.type === "number");

  // The sentence is built from exactly what would be SAVED, so it cannot
  // describe a rule the definition does not contain.
  const definition = definitionFrom(state);
  const keyOf = mintKeys(state.fields);
  const nameOfKey = new Map(
    state.fields.map((f) => [keyOf.get(f.uid)!, f.name.trim() || keyOf.get(f.uid)!]),
  );
  const sentence =
    definition.kind === "call_extractor"
      ? describeLeadRules(
          {
            requiredFields: definition.leadRules?.requiredFields ?? [],
            anyFields: definition.leadRules?.anyFields ?? [],
            minFilled: definition.leadRules?.minFilled ?? 1,
            titleField: definition.leadRules?.titleField,
            valueField: definition.leadRules?.valueField,
            allowFailedValidation: definition.leadRules?.allowFailedValidation ?? false,
          },
          (key) => nameOfKey.get(key) ?? key,
        )
      : "";

  if (named.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        Add the details first - the rules decide which of them a call has to contain.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border rounded-md border border-border">
        {named.map((field) => (
          <li
            key={field.uid}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
          >
            <span className="min-w-0 text-sm text-text">{field.name.trim() || field.key}</span>
            <div className="w-56">
              <Select
                aria-label={`Rule for ${field.name.trim() || field.key}`}
                value={rules.roles[field.uid] ?? "none"}
                onChange={(e) =>
                  set({ roles: { ...rules.roles, [field.uid]: e.target.value as LeadRole } })
                }
              >
                {(Object.keys(ROLE_LABELS) as LeadRole[]).map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>
            </div>
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="lead-min">Details that must be found, at least</Label>
          <Input
            id="lead-min"
            type="number"
            inputMode="numeric"
            min={0}
            max={named.length}
            value={rules.minFilled}
            onChange={(e) =>
              set({ minFilled: Math.max(0, Math.min(64, Number(e.target.value) || 0)) })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="lead-title">Lead card title</Label>
          <Select
            id="lead-title"
            value={rules.titleUid ?? ""}
            onChange={(e) => set({ titleUid: e.target.value || null })}
          >
            <option value="">Caller's name or number</option>
            {named.map((f) => (
              <option key={f.uid} value={f.uid}>
                {f.name.trim() || f.key}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="lead-value">Deal value</Label>
          <Select
            id="lead-value"
            value={rules.valueUid ?? ""}
            onChange={(e) => set({ valueUid: e.target.value || null })}
          >
            <option value="">None</option>
            {numbers.map((f) => (
              <option key={f.uid} value={f.uid}>
                {f.name.trim() || f.key}
              </option>
            ))}
          </Select>
          {numbers.length === 0 ? (
            <p className="text-xs text-text-subtle">Add a Number detail to use it as the value.</p>
          ) : null}
        </div>
      </div>

      <p className="rounded-md bg-bg-subtle px-3 py-2 text-sm text-text">{sentence}</p>
    </div>
  );
}
