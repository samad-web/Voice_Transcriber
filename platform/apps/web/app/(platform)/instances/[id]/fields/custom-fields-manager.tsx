"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  FormField,
  Input,
  MonoLabel,
  Select,
  StatusChip,
  useAlert,
} from "@aura/ui";
import type { CustomFieldDefinition } from "@/app/(owner)/owner/types";
import { archiveFieldAction, createFieldAction } from "./actions";

const OBJECT_TYPES = [
  { value: "contact", label: "Contact" },
  { value: "account", label: "Account" },
  { value: "deal", label: "Deal" },
] as const;

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Yes / No" },
  { value: "picklist", label: "Picklist (one choice)" },
  { value: "multiselect", label: "Multiselect (several choices)" },
  { value: "lookup", label: "Lookup (another object)" },
] as const;

const NEEDS_OPTIONS = new Set(["picklist", "multiselect"]);

/**
 * Define fields on Contact/Account/Deal - CRM Phase 1, E0.2.
 *
 * The form fields are hand-declared here rather than rendered from a spec
 * array, unlike (platform)/crm's provider-picker.tsx: that page renders one
 * of many THIRD-PARTY provider specs, where the fields genuinely differ per
 * provider. Here there is exactly one spec - the field-definition shape
 * itself - so a fixed form is the honest version of the same idea.
 */
export function CustomFieldsManager({
  fields,
  orgId,
}: {
  fields: CustomFieldDefinition[];
  orgId: string;
}) {
  const [objectType, setObjectType] = useState<"contact" | "account" | "deal">("contact");
  const [type, setType] = useState<(typeof FIELD_TYPES)[number]["value"]>("text");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [required, setRequired] = useState(false);
  const [optionsText, setOptionsText] = useState("");
  const [lookupObjectType, setLookupObjectType] = useState<"contact" | "account" | "deal">("contact");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const submit = () => {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      void alert({
        title: "That key won't work",
        body: 'Keys must be snake_case, starting with a letter (e.g. "industry").',
        tone: "danger",
      });
      return;
    }
    if (!label.trim()) {
      void alert({
        title: "The field needs a label",
        body: "The label is what the field is called in the console.",
        tone: "danger",
      });
      return;
    }
    const options = NEEDS_OPTIONS.has(type)
      ? optionsText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((v) => ({ value: v.toLowerCase().replace(/\s+/g, "_"), label: v }))
      : undefined;
    if (NEEDS_OPTIONS.has(type) && (!options || options.length === 0)) {
      void alert({
        title: "This field needs its choices",
        body: "List at least one option, comma-separated.",
        tone: "danger",
      });
      return;
    }

    startTransition(async () => {
      const result = await createFieldAction({
        objectType,
        key,
        label,
        type,
        required,
        options,
        lookupObjectType: type === "lookup" ? lookupObjectType : undefined,
        orgId,
      });
      if (result.error) {
        await alert({
          title: "Couldn't add the field",
          body: result.error,
          tone: "danger",
        });
        return;
      }
      setKey("");
      setLabel("");
      setOptionsText("");
      setRequired(false);
    });
  };

  const archive = (id: string) => {
    startTransition(async () => {
      const result = await archiveFieldAction(id, orgId);
      if (result.error) {
        await alert({
          title: "Couldn't archive the field",
          body: result.error,
          tone: "danger",
        });
      }
    });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card>
        <MonoLabel>New field</MonoLabel>
        <div className="mt-3 space-y-3">
          <FormField label="Object" name="cf-object-type">
            <Select value={objectType} onChange={(e) => setObjectType(e.target.value as typeof objectType)}>
              {OBJECT_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Key" name="cf-key" hint="snake_case, e.g. industry">
            <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="industry" />
          </FormField>
          <FormField label="Label" name="cf-label" hint="What the field is called in the console">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Industry" />
          </FormField>
          <FormField label="Type" name="cf-type">
            <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              {FIELD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </FormField>
          {NEEDS_OPTIONS.has(type) ? (
            <FormField label="Options" name="cf-options" hint="Comma-separated, e.g. Retail, Manufacturing, Services">
              <Input
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                placeholder="Retail, Manufacturing, Services"
              />
            </FormField>
          ) : null}
          {type === "lookup" ? (
            <FormField label="Looks up" name="cf-lookup-object">
              <Select
                value={lookupObjectType}
                onChange={(e) => setLookupObjectType(e.target.value as typeof lookupObjectType)}
              >
                {OBJECT_TYPES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
          <Checkbox
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            label="Required"
          />
          <Button type="button" onClick={submit} loading={pending}>
            Add field
          </Button>
        </div>
      </Card>

      <div className="space-y-4">
        {OBJECT_TYPES.map((ot) => {
          const rows = fields.filter((f) => f.object_type === ot.value);
          return (
            <Card key={ot.value}>
              <MonoLabel>{ot.label} fields</MonoLabel>
              {rows.length === 0 ? (
                <EmptyState
                  title={`No custom fields on ${ot.label.toLowerCase()} yet`}
                  description="Fields defined above appear here, grouped by the object they're on."
                />
              ) : (
                <div className="mt-3 divide-y divide-border rounded-md border border-border">
                  {rows.map((field) => (
                    <div
                      key={field.id}
                      className="flex items-center justify-between gap-3 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-text">{field.label}</span>
                          <StatusChip tone="outline">{field.type}</StatusChip>
                          {field.required ? <StatusChip tone="muted">required</StatusChip> : null}
                        </div>
                        <span className="text-xs text-text-muted">{field.key}</span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => archive(field.id)}
                      >
                        Archive
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
