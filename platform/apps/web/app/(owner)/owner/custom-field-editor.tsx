"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { Button, Checkbox, Input, MonoLabel, Select, useAlert, useToast } from "@aura/ui";
import {
  fetchCustomFieldsAction,
  saveCustomFieldsAction,
  type TimelineParent,
} from "./crm-actions";
import { RecordPicker } from "./record-picker";
import { relativeTime, type RecordCustomField } from "./types";

/**
 * The custom fields an admin defined, on one record, editable.
 *
 * The missing half of Track A4. The pipeline has been writing typed values
 * into these tables on every call since `6e4dead`, and until now there was no
 * route and no screen that read them back - the field existed, the data
 * existed, and nobody could see either.
 *
 * FETCHES ON MOUNT, like InteractionTimeline and for the same reason: the
 * board and list queries don't carry custom fields, and making them would
 * mean an EAV join on every row of a page that mostly won't display it.
 *
 * ONLY CHANGED FIELDS ARE SENT. The API treats an absent key as "leave alone"
 * and an explicit null as "clear", which is a distinction a full-form PUT
 * would destroy: submitting every field would restamp untouched AI-populated
 * values as human-owned and permanently freeze the extraction out of them.
 */
export function CustomFieldEditor({
  parent,
  parentId,
  title = "Fields",
}: {
  parent: TimelineParent;
  parentId: string;
  title?: string;
}) {
  const [fields, setFields] = useState<RecordCustomField[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  // Why the panel is empty, not how a save went - it takes the place of the
  // field list rather than reporting an event, so it stays on the page.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const load = useCallback(() => {
    let cancelled = false;
    void fetchCustomFieldsAction(parent, parentId).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setLoadError(result.error);
        setFields([]);
        return;
      }
      setLoadError(null);
      setFields(result.fields ?? []);
      setDrafts({});
    });
    return () => {
      cancelled = true;
    };
  }, [parent, parentId]);

  useEffect(() => {
    setFields(null);
    return load();
  }, [load]);

  const edit = (key: string, value: unknown) => {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  };

  const save = () => {
    const keys = Object.keys(drafts);
    if (keys.length === 0) return;
    startTransition(async () => {
      // "" means the person emptied the box, which is a request to clear the
      // field - sent as an explicit null so the API deletes the row rather
      // than storing an empty string that would render as a filled-in blank.
      const payload: Record<string, unknown> = {};
      for (const key of keys) {
        const value = drafts[key];
        payload[key] = value === "" || (Array.isArray(value) && value.length === 0) ? null : value;
      }
      const result = await saveCustomFieldsAction(parent, parentId, payload);
      if (result.error) {
        await alert({ title: "Couldn't save the fields", body: result.error, tone: "danger" });
        return;
      }
      // The API returns the re-read record, so provenance and timestamps
      // update in place without a second round trip.
      setFields(result.fields ?? []);
      setDrafts({});
      toast("Saved");
    });
  };

  if (fields === null) {
    return (
      <div className="space-y-3">
        <MonoLabel>{title}</MonoLabel>
        <p className="py-2 text-xs text-text-muted">Loading…</p>
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div className="space-y-3">
        <MonoLabel>{title}</MonoLabel>
        <p className="py-2 text-xs text-text-muted">
          {loadError ?? "No custom fields defined for this object yet."}
        </p>
      </div>
    );
  }

  const dirty = Object.keys(drafts).length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>{title}</MonoLabel>
        {dirty ? (
          <Button type="button" size="sm" onClick={save} loading={pending}>
            Save
          </Button>
        ) : null}
      </div>

      <dl className="space-y-3">
        {fields.map((field) => {
          const current = field.key in drafts ? drafts[field.key] : field.value;
          return (
            <div key={field.id}>
              <dt className="flex items-center gap-1.5 text-xs text-text-muted">
                <span>{field.label}</span>
                {field.required ? <span className="text-danger-text">*</span> : null}
                {field.status === "archived" ? (
                  <span className="text-text-subtle">(archived)</span>
                ) : null}
                {/* The one piece of provenance worth putting on screen: a value
                    the AI guessed reads differently from one a colleague typed,
                    and a rep about to quote it deserves to know which. */}
                {field.source === "extraction" && !(field.key in drafts) ? (
                  <span
                    title={`Extracted by AI${field.updatedAt ? ` ${relativeTime(field.updatedAt)}` : ""}`}
                    className="inline-flex items-center"
                  >
                    <Sparkles className="h-3 w-3 text-text-subtle" aria-label="Extracted by AI" />
                  </span>
                ) : null}
              </dt>
              <dd className="mt-1">
                <FieldInput
                  field={field}
                  value={current}
                  disabled={field.status === "archived"}
                  onChange={(value) => edit(field.key, value)}
                />
                {field.source === "human" && field.updatedBy ? (
                  <p className="mt-1 text-xs text-text-subtle">
                    {field.updatedBy} · {relativeTime(field.updatedAt)}
                  </p>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** One input per field type - the render half of `parseCustomFieldValue`. */
function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: RecordCustomField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  switch (field.type) {
    case "boolean":
      return (
        <Checkbox
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          // Never empty: Checkbox's own contract is that an unlabelled box is
          // a WCAG failure. Falls back to repeating the field name rather than
          // rendering "" when the admin wrote no description.
          label={field.description ?? field.label}
        />
      );

    case "picklist":
      return (
        <Select
          value={value === null || value === undefined ? "" : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">-</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      );

    case "multiselect": {
      const selected = new Set(Array.isArray(value) ? value.map(String) : []);
      return (
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((option) => {
            const on = selected.has(option.value);
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => {
                  const next = new Set(selected);
                  if (on) next.delete(option.value);
                  else next.add(option.value);
                  onChange([...next]);
                }}
                className={`inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50 ${
                  on
                    ? "border-transparent bg-accent-subtle text-accent-text"
                    : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      );
    }

    case "date":
      return (
        <Input
          type="date"
          value={value === null || value === undefined ? "" : String(value).slice(0, 10)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case "number":
      return (
        <Input
          type="number"
          inputMode="decimal"
          value={value === null || value === undefined ? "" : String(value)}
          disabled={disabled}
          min={field.validation?.min}
          max={field.validation?.max}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case "lookup":
      return (
        <RecordPicker
          objectType={(field.lookupObjectType as "contact" | "account" | "deal") ?? "contact"}
          value={value === null || value === undefined ? null : String(value)}
          disabled={disabled}
          // `null` clears the field - the same distinction the API draws
          // between an absent key and an explicit null.
          onChange={(id) => onChange(id)}
        />
      );

    default:
      return (
        <Input
          value={value === null || value === undefined ? "" : String(value)}
          disabled={disabled}
          placeholder={field.description ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
