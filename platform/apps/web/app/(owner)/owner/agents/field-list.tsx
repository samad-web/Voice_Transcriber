"use client";

import { AGENT_FIELD_TYPE_LABELS, type ExtractionFieldType } from "@aura/shared";
import { Button, Input, Label, Select } from "@aura/ui";
import { blankField, type EditorField } from "@/lib/agent-studio";

export const TEXTAREA_CLASS =
  "w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-to";

const TYPES = Object.keys(AGENT_FIELD_TYPE_LABELS) as ExtractionFieldType[];

/**
 * The details an agent pulls out, one row each.
 *
 * ── A SAVED DETAIL'S NAME IS NOT EDITABLE ───────────────────────────────────
 *
 * Its key is what every call's facts and every lead's facts are filed under.
 * The name shown is derived from that key, so "renaming" it would have to
 * change the key - which orphans the history the same way renaming a call
 * procedure step would. The row says so, and offers the honest alternative:
 * add a new detail.
 *
 * ── WHY `required` IS NOT OFFERED ───────────────────────────────────────────
 *
 * In the extraction schema "required" means "a call that does not mention this
 * FAILS validation" - and a failed call never becomes a lead. An owner ticking
 * a box labelled Required almost always means "a lead must have this", which
 * is the lead rules panel's "Must be found", and does not throw away the rest
 * of the call. The flag is carried through untouched for agents that already
 * set it.
 */
export function FieldList({
  fields,
  maxFields,
  onChange,
  noun,
}: {
  fields: EditorField[];
  maxFields: number;
  onChange: (fields: EditorField[]) => void;
  /** "call" or "conversation", for the hint text. */
  noun: string;
}) {
  const update = (uid: string, patch: Partial<EditorField>) =>
    onChange(fields.map((f) => (f.uid === uid ? { ...f, ...patch } : f)));

  return (
    <div className="space-y-3">
      {fields.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-muted">
          No details yet. Add the things you want written down from every {noun}.
        </p>
      ) : null}

      {fields.map((field, i) => (
        <div key={field.uid} className="space-y-3 rounded-md border border-border p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem]">
            <div className="min-w-0 space-y-1">
              <Label htmlFor={`${field.uid}-name`}>Detail {i + 1}</Label>
              {field.key ? (
                <div id={`${field.uid}-name`} className="space-y-0.5">
                  <p className="text-sm font-medium text-text">{field.name}</p>
                  <p className="text-xs text-text-subtle">
                    Saved as <code>{field.key}</code>. To call it something else, add a new detail -
                    renaming would disconnect it from what earlier {noun}s recorded.
                  </p>
                </div>
              ) : (
                <Input
                  id={`${field.uid}-name`}
                  value={field.name}
                  onChange={(e) => update(field.uid, { name: e.target.value })}
                  placeholder="e.g. Budget"
                />
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${field.uid}-type`}>Kind of answer</Label>
              <Select
                id={`${field.uid}-type`}
                value={field.type}
                onChange={(e) => update(field.uid, { type: e.target.value as ExtractionFieldType })}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {AGENT_FIELD_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor={`${field.uid}-desc`}>What to look for</Label>
            <textarea
              id={`${field.uid}-desc`}
              rows={2}
              className={TEXTAREA_CLASS}
              value={field.description}
              onChange={(e) => update(field.uid, { description: e.target.value })}
              placeholder={`Say exactly what counts, e.g. "The budget the customer stated, as a number. Leave empty if they gave none."`}
            />
          </div>

          {field.type === "enum" ? (
            <div className="space-y-1">
              <Label htmlFor={`${field.uid}-options`}>Allowed answers</Label>
              <Input
                id={`${field.uid}-options`}
                value={field.options}
                onChange={(e) => update(field.uid, { options: e.target.value })}
                placeholder="hot, warm, cold"
              />
              <p className="text-xs text-text-subtle">Separate them with commas.</p>
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(fields.filter((f) => f.uid !== field.uid))}
              aria-label={`Remove detail ${i + 1}`}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => onChange([...fields, blankField()])}
          disabled={fields.length >= maxFields}
        >
          Add a detail
        </Button>
        <span className="text-xs text-text-muted">
          {fields.length} of {maxFields}
        </span>
      </div>
    </div>
  );
}
