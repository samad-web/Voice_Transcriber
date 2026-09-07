"use client";

import { useState, useTransition } from "react";
import { Button, FormField, Input, useAlert, useToast } from "@aura/ui";
import { updateBrandingAction, type BrandingPatch } from "./actions";

export interface BrandingView {
  logoUrl: string;
  faviconUrl: string;
  bannerUrl: string;
  loginBackgroundUrl: string;
  primaryColor: string;
  secondaryColor: string;
  appBackgroundColor: string;
  browserTitle: string;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The three colour fields, so validation and the swatch row stay one list. */
const COLORS = [
  {
    key: "primaryColor",
    label: "Brand colour",
    placeholder: "#2563eb",
    hint: "Buttons, links and the active state. Hex format.",
  },
  {
    key: "secondaryColor",
    label: "Accent",
    placeholder: "#0f172a",
    hint: "Secondary emphasis beside the brand colour. Hex format.",
  },
  {
    key: "appBackgroundColor",
    label: "App background",
    placeholder: "#f8fafc",
    hint: "The page behind the console. Leave blank to keep the default.",
  },
] as const;

type ColorKey = (typeof COLORS)[number]["key"];

/** The four image fields. URLs, not uploads - see the API's own note on why. */
const IMAGES = [
  {
    key: "logoUrl",
    label: "Logo",
    placeholder: "https://example.com/logo.png",
    hint: "Shown in the console sidebar and on the sign-in screen.",
  },
  {
    key: "faviconUrl",
    label: "Favicon",
    placeholder: "https://example.com/favicon.png",
    hint: "The small icon in the browser tab. A square PNG or ICO works best.",
  },
  {
    key: "bannerUrl",
    label: "Banner",
    placeholder: "https://example.com/banner.png",
    hint: "A wide image for the top of the console. Optional.",
  },
  {
    key: "loginBackgroundUrl",
    label: "Sign-in background",
    placeholder: "https://example.com/login-bg.jpg",
    hint: "Fills the background of the sign-in screen.",
  },
] as const;

type ImageKey = (typeof IMAGES)[number]["key"];

/**
 * The white-label surface for one org.
 *
 * ── WHY THESE EIGHT FIELDS ──────────────────────────────────────────────────
 *
 * They are the set the Hawcus gap analysis (§3.8) records: logo, favicon,
 * banner, brand colour, sign-in background, tab title, app background, accent.
 * Four already existed here under slightly different names - `secondaryColor`
 * IS the accent, `browserTitle` IS the tab title - so the keys were kept rather
 * than renamed. Renaming them would have orphaned the branding every existing
 * tenant has already saved, for a cosmetic gain.
 *
 * ── ONLY CHANGED FIELDS ARE SENT ────────────────────────────────────────────
 *
 * The same discipline custom-field-editor.tsx uses: PATCH /org/branding merges
 * into the existing jsonb, so sending the whole form would be harmless - but
 * the diff keeps the request legible and matches the rest of the console's
 * PATCH actions. Colours are validated here against the same `#rrggbb` regex
 * the API enforces (tenancy.controller.ts's `BrandingBody`), so a typo shows up
 * next to the field instead of as a round-tripped 400.
 *
 * ── URLS, NOT UPLOADS ───────────────────────────────────────────────────────
 *
 * There is no asset pipeline in this console and inventing one for a favicon
 * would be the tail wagging the dog. Every image field says so in its hint,
 * rather than offering a file picker that would not work.
 */
export function BrandingForm({ initial }: { initial: BrandingView }) {
  const [form, setForm] = useState<BrandingView>(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const set = (key: keyof BrandingView, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = () => {
    const errors: Record<string, string> = {};
    for (const c of COLORS) {
      const v = form[c.key].trim();
      if (v && !HEX_COLOR.test(v)) errors[c.key] = `Enter a hex colour like ${c.placeholder}.`;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const patch: BrandingPatch = {};
    // Images clear to null - "no logo" means fall back to the default asset,
    // which the API reads as null rather than as an empty string.
    for (const i of IMAGES) {
      const v = form[i.key].trim();
      if (v !== initial[i.key]) patch[i.key as ImageKey] = v ? v : null;
    }
    for (const c of COLORS) {
      const v = form[c.key].trim();
      if (v !== initial[c.key]) patch[c.key as ColorKey] = v;
    }
    if (form.browserTitle.trim() !== initial.browserTitle) {
      patch.browserTitle = form.browserTitle.trim();
    }

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

  const swatch = (value: string) => (HEX_COLOR.test(value.trim()) ? value.trim() : "transparent");

  return (
    <div className="max-w-lg space-y-6">
      <section className="space-y-4">
        <p className="text-xs font-medium tracking-wide text-text-muted uppercase">Images</p>
        {IMAGES.map((i) => (
          <FormField key={i.key} label={i.label} name={i.key} hint={i.hint}>
            <Input
              value={form[i.key]}
              onChange={(e) => set(i.key, e.target.value)}
              placeholder={i.placeholder}
              type="url"
            />
          </FormField>
        ))}
      </section>

      <section className="space-y-4">
        <p className="text-xs font-medium tracking-wide text-text-muted uppercase">Colours</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {COLORS.map((c) => (
            <FormField
              key={c.key}
              label={c.label}
              name={c.key}
              error={fieldErrors[c.key]}
              hint={fieldErrors[c.key] ? undefined : c.hint}
            >
              <Input
                value={form[c.key]}
                onChange={(e) => set(c.key, e.target.value)}
                placeholder={c.placeholder}
              />
            </FormField>
          ))}
        </div>

        <div>
          <p className="text-xs text-text-muted">Preview</p>
          <div className="mt-1.5 flex items-center gap-2">
            {COLORS.map((c) => (
              <div
                key={c.key}
                className="h-10 w-10 rounded-md border border-border-strong"
                style={{ backgroundColor: swatch(form[c.key]) }}
                title={form[c.key] || c.label}
              />
            ))}
            {form.logoUrl.trim() ? (
              // A raw <img>, not next/image, on purpose - the same reasoning
              // enrollment-credentials.tsx gives for its own: the source is an
              // arbitrary tenant-supplied URL, and next/image needs every host
              // allowlisted at build time, which a tenant editing this field
              // cannot do.
              <img
                src={form.logoUrl.trim()}
                alt="Logo preview"
                className="h-10 w-auto max-w-[8rem] rounded-md border border-border object-contain"
              />
            ) : null}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <p className="text-xs font-medium tracking-wide text-text-muted uppercase">Browser</p>
        <FormField
          label="Tab title"
          name="browserTitle"
          hint="Shown in the browser tab in place of the default title."
        >
          <Input
            value={form.browserTitle}
            onChange={(e) => set("browserTitle", e.target.value)}
            placeholder="Acme CRM"
            maxLength={120}
          />
        </FormField>
      </section>

      <Button type="button" loading={pending} onClick={save}>
        Save
      </Button>
    </div>
  );
}
