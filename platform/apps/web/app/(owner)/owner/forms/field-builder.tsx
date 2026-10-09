"use client";

import { useState, useTransition } from "react";
import { ErrorBanner, MonoLabel, useToast } from "@aura/ui";
import {
  OPTION_TYPES,
  WEB_FORM_MAX_FIELDS,
  WEB_FORM_RESERVED_KEYS,
  type WebFormField,
  type WebFormFieldType,
} from "@aura/shared/dist/web-forms";
import { updateWebFormAction } from "./actions";
import type { WebFormView } from "./forms-console";

const FIELD =
  "rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text disabled:opacity-60";

/**
 * The nine types offered, of 0161's thirteen.
 *
 * `hidden`, `multiselect` and `consent` are left out of the PICKER rather than
 * out of the schema. `consent` is handled by the form's own consent sentence -
 * two places to ask the same question would let a tenant publish a form whose
 * tick box and whose recorded basis disagree. `hidden` is for an embed passing
 * a campaign id and belongs with the embed snippet, not here. `multiselect` is
 * the only type whose answer is an array, so every downstream reader has to
 * special-case it; offering it before that is exercised is how a form collects
 * data nothing can display.
 */
const OFFERED_TYPES: WebFormFieldType[] = [
  "text",
  "email",
  "phone",
  "number",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "date",
];

const TYPE_LABEL: Record<string, string> = {
  text: "Short text",
  email: "Email",
  phone: "Phone number",
  number: "Number",
  textarea: "Long text",
  select: "Pick one (dropdown)",
  radio: "Pick one (buttons)",
  checkbox: "Yes / no",
  date: "Date",
};

/** `label` → a key, the way somebody would expect it to be spelled. */
function keyFor(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "field";
  // 0161 reserves a handful of keys for the submission envelope, and a field
  // called `slug` or `source` would collide with them. Suffix rather than
  // refuse: the person typed a label, not a key, and they should not have to
  // know which words are spoken for.
  let candidate = WEB_FORM_RESERVED_KEYS.includes(base) ? `${base}_field` : base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}_${n++}`;
  return candidate;
}

/**
 * The question list for one form (Build docs/40 §B4).
 *
 * ── THE KEY IS DERIVED, AND NEVER CHANGED AFTERWARDS ───────────────────────
 *
 * `key` is what every submission is stored under, so renaming it on a published
 * form orphans every answer already collected - the old rows keep the old key
 * and nothing joins them up again. So it is generated from the label when a
 * field is ADDED, shown read-only, and left alone when the label is edited
 * later. A tenant who wants a different key deletes the field and adds it back,
 * which at least makes the loss visible.
 *
 * Saved as one whole definition rather than per field, because that is what the
 * API takes: `WebFormDefinition` is validated as a unit (duplicate keys, the
 * 60-field ceiling, a `showIf` pointing at a field that exists), and sending
 * one field at a time would mean the server could never check any of it.
 */
export function FieldBuilder({
  form,
  onSaved,
  onCancel,
}: {
  form: WebFormView;
  onSaved: (next: WebFormView) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<WebFormField[]>(form.definition.fields);
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<WebFormFieldType>("text");

  const taken = new Set(fields.map((f) => f.key));

  const add = () => {
    const label = newLabel.trim();
    if (!label) return;
    if (fields.length >= WEB_FORM_MAX_FIELDS) {
      setError(`A form can have at most ${WEB_FORM_MAX_FIELDS} questions.`);
      return;
    }
    setError(null);
    setFields((list) => [
      ...list,
      {
        key: keyFor(label, taken),
        type: newType,
        label,
        required: false,
        options: OPTION_TYPES.has(newType) ? [{ value: "option_1", label: "Option 1" }] : [],
      } as WebFormField,
    ]);
    setNewLabel("");
  };

  const patch = (index: number, change: Partial<WebFormField>) =>
    setFields((list) =>
      list.map((f, i) => (i === index ? ({ ...f, ...change } as WebFormField) : f)),
    );

  const move = (index: number, by: -1 | 1) =>
    setFields((list) => {
      const next = [...list];
      const target = index + by;
      if (target < 0 || target >= next.length) return list;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await updateWebFormAction(form.id, { definition: { fields } });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.form) onSaved(result.form as WebFormView);
      toast("Questions saved");
    });
  };

  return (
    <div className="space-y-4 border-t border-border pt-4">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {fields.length === 0 ? (
        <p className="text-sm text-text-muted">No questions yet. Add one below.</p>
      ) : (
        <ul className="space-y-3">
          {fields.map((field, index) => (
            <li key={field.key} className="rounded-md border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                <div className="space-y-1.5">
                  <MonoLabel>Question</MonoLabel>
                  <input
                    className={`${FIELD} w-full`}
                    value={field.label}
                    disabled={pending}
                    onChange={(e) => patch(index, { label: e.target.value })}
                  />
                  <span className="block text-xs text-text-muted">
                    Stored as <code>{field.key}</code> — that cannot change once answers exist.
                  </span>
                </div>

                <div className="space-y-1.5">
                  <MonoLabel>Type</MonoLabel>
                  <select
                    className={`${FIELD} w-full`}
                    value={field.type}
                    disabled={pending}
                    onChange={(e) => {
                      const type = e.target.value as WebFormFieldType;
                      patch(index, {
                        type,
                        // A type that needs options must not arrive with none -
                        // `WebFormField` refuses that, and the refusal would
                        // land as a whole-definition error on save rather than
                        // next to the field somebody just changed.
                        options: OPTION_TYPES.has(type)
                          ? field.options.length > 0
                            ? field.options
                            : [{ value: "option_1", label: "Option 1" }]
                          : [],
                      });
                    }}
                  >
                    {OFFERED_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t] ?? t}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-end gap-2">
                  <label className="flex items-center gap-1.5 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={field.required}
                      disabled={pending}
                      onChange={(e) => patch(index, { required: e.target.checked })}
                    />
                    Required
                  </label>
                </div>
              </div>

              {OPTION_TYPES.has(field.type) ? (
                <div className="mt-3 space-y-1.5">
                  <MonoLabel>Choices</MonoLabel>
                  <textarea
                    className={`${FIELD} w-full`}
                    rows={3}
                    disabled={pending}
                    value={field.options.map((o) => o.label).join("\n")}
                    aria-label={`Choices for ${field.label}`}
                    onChange={(e) =>
                      patch(index, {
                        options: e.target.value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean)
                          .slice(0, 100)
                          .map((label, i) => ({ value: `option_${i + 1}`, label })),
                      })
                    }
                  />
                  <span className="block text-xs text-text-muted">One per line.</span>
                </div>
              ) : null}

              <div className="mt-3 flex gap-3 border-t border-border pt-2">
                <button
                  type="button"
                  className="text-sm text-text-muted hover:underline disabled:opacity-40"
                  disabled={pending || index === 0}
                  onClick={() => move(index, -1)}
                >
                  Move up
                </button>
                <button
                  type="button"
                  className="text-sm text-text-muted hover:underline disabled:opacity-40"
                  disabled={pending || index === fields.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Move down
                </button>
                <button
                  type="button"
                  className="ml-auto text-sm text-text-muted hover:underline disabled:opacity-60"
                  disabled={pending}
                  onClick={() => setFields((list) => list.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
        <label className="space-y-1.5">
          <MonoLabel>Add a question</MonoLabel>
          <input
            className={`${FIELD} w-56`}
            value={newLabel}
            disabled={pending}
            placeholder="e.g. Which city?"
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        </label>
        <select
          className={FIELD}
          value={newType}
          disabled={pending}
          aria-label="What kind of answer"
          onChange={(e) => setNewType(e.target.value as WebFormFieldType)}
        >
          {OFFERED_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t] ?? t}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
          disabled={pending || !newLabel.trim()}
          onClick={add}
        >
          Add
        </button>
      </div>

      <div className="flex gap-2 border-t border-border pt-3">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
          disabled={pending}
          onClick={save}
        >
          Save questions
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
