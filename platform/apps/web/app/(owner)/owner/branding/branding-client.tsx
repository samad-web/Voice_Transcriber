"use client";

import { useState, useTransition } from "react";
import { Button, FormField, Input, useAlert, useToast } from "@aura/ui";
import { updateBrandingAction, type BrandingPatch } from "./actions";

export interface BrandingView {
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  browserTitle: string;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Org logo/colors form (Kailash gap Milestone 4).
 *
 * ONLY CHANGED FIELDS ARE SENT, the same discipline custom-field-editor.tsx
 * uses: PATCH /org/branding merges into the existing jsonb, so submitting the
 * whole form every time would be harmless here (there's no provenance to
 * disturb, unlike custom fields) but sending the diff keeps the request
 * legible and matches the rest of the console's PATCH actions.
 *
 * Colors are validated client-side against the same `#rrggbb` regex the API
 * enforces (tenancy.controller.ts's `BrandingBody`), so a typo shows up next
 * to the field instead of as a round-tripped 400.
 */
export function BrandingForm({ initial }: { initial: BrandingView }) {
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [primaryColor, setPrimaryColor] = useState(initial.primaryColor);
  const [secondaryColor, setSecondaryColor] = useState(initial.secondaryColor);
  const [browserTitle, setBrowserTitle] = useState(initial.browserTitle);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const save = () => {
    const errors: Record<string, string> = {};
    if (primaryColor.trim() && !HEX_COLOR.test(primaryColor.trim())) {
      errors.primaryColor = "Enter a hex color like #2563eb.";
    }
    if (secondaryColor.trim() && !HEX_COLOR.test(secondaryColor.trim())) {
      errors.secondaryColor = "Enter a hex color like #0f172a.";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    // Only send what actually changed from what the page loaded with.
    const patch: BrandingPatch = {};
    if (logoUrl.trim() !== initial.logoUrl) patch.logoUrl = logoUrl.trim() ? logoUrl.trim() : null;
    if (primaryColor.trim() !== initial.primaryColor) patch.primaryColor = primaryColor.trim();
    if (secondaryColor.trim() !== initial.secondaryColor) patch.secondaryColor = secondaryColor.trim();
    if (browserTitle.trim() !== initial.browserTitle) patch.browserTitle = browserTitle.trim();

    if (Object.keys(patch).length === 0) {
      toast("Saved");
      return;
    }

    startTransition(async () => {
      const result = await updateBrandingAction(patch);
      if (result.error) {
        await alert({ title: "Couldn't save your branding", body: result.error, tone: "danger" });
        return;
      }
      toast("Saved");
    });
  };

  return (
    <div className="max-w-lg space-y-4">
      <FormField label="Logo URL" name="logoUrl" hint="A link to an already-hosted image - there's no upload here.">
        <Input
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://example.com/logo.png"
          type="url"
        />
      </FormField>

      <FormField label="Browser title" name="browserTitle" hint="Shown in the browser tab in place of the default title.">
        <Input
          value={browserTitle}
          onChange={(e) => setBrowserTitle(e.target.value)}
          placeholder="Acme CRM"
          maxLength={120}
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Primary color"
          name="primaryColor"
          error={fieldErrors.primaryColor}
          hint={fieldErrors.primaryColor ? undefined : "Hex format, e.g. #2563eb."}
        >
          <Input
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
            placeholder="#2563eb"
          />
        </FormField>

        <FormField
          label="Secondary color"
          name="secondaryColor"
          error={fieldErrors.secondaryColor}
          hint={fieldErrors.secondaryColor ? undefined : "Hex format, e.g. #0f172a."}
        >
          <Input
            value={secondaryColor}
            onChange={(e) => setSecondaryColor(e.target.value)}
            placeholder="#0f172a"
          />
        </FormField>
      </div>

      <div>
        <p className="text-xs text-text-muted">Preview</p>
        <div className="mt-1.5 flex items-center gap-2">
          <div
            className="h-10 w-10 rounded-md border border-border-strong"
            style={{ backgroundColor: HEX_COLOR.test(primaryColor.trim()) ? primaryColor.trim() : "transparent" }}
            title={primaryColor || "Primary color"}
          />
          <div
            className="h-10 w-10 rounded-md border border-border-strong"
            style={{ backgroundColor: HEX_COLOR.test(secondaryColor.trim()) ? secondaryColor.trim() : "transparent" }}
            title={secondaryColor || "Secondary color"}
          />
        </div>
      </div>

      <Button type="button" loading={pending} onClick={save}>
        Save
      </Button>
    </div>
  );
}
