"use client";

import { useMemo, useState, useTransition } from "react";
import { isUsableAppBackground, kpiSurface, STOCK_KPI } from "@aura/shared";
import { Button, FormField, Input, RowHint, useAlert, useToast } from "@aura/ui";
import { updateBrandingAction, type BrandingPatch } from "./actions";

/** The form's own state: every field as a string, "" for unset. */
export interface BrandingView {
  logoUrl: string;
  faviconUrl: string;
  bannerUrl: string;
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
    hint: "Buttons, page headings, tabs and the active menu item - and the dashboard tiles, unless you set an accent below. Hex format.",
  },
  {
    key: "secondaryColor",
    label: "Accent",
    placeholder: "#0f172a",
    hint: "The far end of the brand gradient, and the fill behind the dashboard's KPI tiles. Leave blank to deepen the brand colour instead.",
  },
  {
    key: "appBackgroundColor",
    label: "App background",
    placeholder: "#f8fafc",
    hint: "The page behind the console. Keep it light - console text is printed directly on it.",
  },
] as const;

type ColorKey = (typeof COLORS)[number]["key"];

/**
 * The three image fields. URLs, not uploads - see the API's own note on why.
 *
 * "Sign-in background" is gone. Every tenant signs in at the same address, so
 * that screen has no org to look branding up for and the field could never do
 * anything once saved. The logo hint below no longer claims the sign-in screen
 * either, for the same reason.
 */
const IMAGES = [
  {
    key: "logoUrl",
    label: "Logo",
    placeholder: "https://example.com/logo.png",
    hint: "Shown in the console sidebar, and in the header on phones.",
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
    hint: "A wide image across the top of every console page. Optional.",
  },
] as const;

type ImageKey = (typeof IMAGES)[number]["key"];

/**
 * The white-label surface for one org.
 *
 * ── WHY THESE SEVEN FIELDS ──────────────────────────────────────────────────
 *
 * They are the set the Hawcus gap analysis (§3.8) records - logo, favicon,
 * banner, brand colour, sign-in background, tab title, app background, accent -
 * minus the sign-in background, which this product cannot deliver: every tenant
 * signs in at the same `<origin>/login`, with no subdomain and no org in the
 * path, so that screen has no tenant to resolve branding for. It was a control
 * that did nothing when saved. Stored values are untouched; the field simply
 * isn't offered any more.
 *
 * Four of the rest already existed under slightly different names -
 * `secondaryColor` IS the accent, `browserTitle` IS the tab title - so the keys
 * were kept rather than renamed. Renaming would have orphaned the branding every
 * existing tenant has already saved, for a cosmetic gain.
 *
 * ── ONLY CHANGED FIELDS ARE SENT ────────────────────────────────────────────
 *
 * The same discipline custom-field-editor.tsx uses: PATCH /org/branding merges
 * into the existing jsonb, so sending the whole form would be harmless - but
 * the diff keeps the request legible and matches the rest of the console's
 * PATCH actions. Colours are validated here against the same `#rrggbb` regex
 * the API enforces (`Branding` in @aura/shared, which is now literally the same
 * schema object), so a typo shows up next to the field instead of as a
 * round-tripped 400.
 *
 * ── THE APP BACKGROUND IS CONTRAST-CHECKED ──────────────────────────────────
 *
 * Console text is printed DIRECTLY on that colour using `--color-text`, which
 * the tenant is not choosing. A dark value there would blank every page, so it
 * is refused here with the reason, and refused again in `brandingCssVars` for
 * anything that arrives another way. The other two colours need no such check -
 * their foregrounds are computed from them.
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
    // Say why, at the field, rather than accepting a value the console would
    // then decline to paint - a setting that saves successfully and visibly
    // does nothing is the exact failure this whole pass is fixing.
    const background = form.appBackgroundColor.trim();
    if (!errors.appBackgroundColor && background && !isUsableAppBackground(background)) {
      errors.appBackgroundColor =
        "Too dark - the console prints its text straight onto this colour. Pick a lighter shade.";
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

  /**
   * The dashboard tile, rendered from the same function the server will run.
   *
   * Not a swatch of the raw hex. `kpiSurface` may move the fill - see its
   * header - and a preview showing the colour they typed rather than the
   * colour they will get is worse than no preview at all: it would make the
   * adjustment look like a bug the first time they saw the real dashboard.
   *
   * Seeded accent-then-brand, matching `brandingCssVars` exactly. Falls back to
   * the shipped orange so the tile is never blank while somebody is mid-type.
   */
  const kpi = useMemo(() => {
    const accent = form.secondaryColor.trim();
    const brand = form.primaryColor.trim();
    const seed = HEX_COLOR.test(accent) ? accent : HEX_COLOR.test(brand) ? brand : STOCK_KPI;
    return { ...kpiSurface(seed), seed };
  }, [form.primaryColor, form.secondaryColor]);

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

          {/* The real thing, not a swatch: a dashboard tile with a label, a
              number and a context line, in the colours this org will actually
              render. Those three lines are the point - a 40px square cannot
              show that 12px type is legible on the fill, which is the only
              question worth asking about a colour that becomes a background. */}
          <div
            className="mt-1.5 flex flex-col justify-between rounded-xl p-4"
            style={{ backgroundColor: kpi.fill, color: kpi.fg }}
          >
            <p className="text-xs font-medium">Open leads</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">128</p>
            <p className="mt-1 text-xs">14 new in 30d</p>
            <div
              className="mt-3 border-t pt-2 text-xs"
              style={{ borderColor: kpi.hairline }}
            >
              Dashboard tile
            </div>
          </div>

          {kpi.adjusted ? (
            // Said plainly, before they save, rather than left to be noticed on
            // the dashboard. The alternative to adjusting is refusing the
            // colour outright, which for a brand guide that says "our orange is
            // #FF0000" would mean telling a customer their brand is not
            // allowed.
            <RowHint kind="action">
              Deepened slightly from {kpi.seed} so the tile&rsquo;s label and context line stay
              readable on it. The hue is unchanged - only how light it is.
            </RowHint>
          ) : null}

          <div className="mt-3 flex items-center gap-2">
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
