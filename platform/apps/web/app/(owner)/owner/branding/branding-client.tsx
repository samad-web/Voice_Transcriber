"use client";

import { useState, useTransition } from "react";
import { useDraftState } from "@/lib/use-server-state";
import type { ReactNode } from "react";
import { Button, DropZone, FormField, Input, useAlert, useToast } from "@aura/ui";
import { isUsableAppBackground, isUsableTextColor, type BrandingPreset } from "@aura/shared";
import { getBrandingUploadUrlAction, updateBrandingAction, type BrandingPatch } from "./actions";

type TabId = "images" | "colours" | "palettes" | "browser";

/** The form's own state: every field as a string, "" for unset. */
export interface BrandingView {
  logoUrl: string;
  faviconUrl: string;
  bannerUrl: string;
  sidebarIconUrl: string;
  loginBackgroundUrl: string;
  primaryColor: string;
  secondaryColor: string;
  appBackgroundColor: string;
  textColor: string;
  primaryHoverColor: string;
  secondaryHoverColor: string;
  browserTitle: string;
  presets: BrandingPreset[];
}

/** The subset of the view that makes up one saved palette - see branding.ts's `BrandingPalette`. */
const PALETTE_KEYS = [
  "primaryColor",
  "secondaryColor",
  "appBackgroundColor",
  "textColor",
  "primaryHoverColor",
  "secondaryHoverColor",
] as const;
type PaletteKey = (typeof PALETTE_KEYS)[number];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The six colour fields, so validation and the swatch row stay one list. */
const COLORS = [
  {
    key: "primaryColor",
    label: "Primary",
    placeholder: "#2563eb",
    hint: "Buttons, links, the active nav item and the gradient's first stop. Hex format.",
  },
  {
    key: "secondaryColor",
    label: "Secondary",
    placeholder: "#0f172a",
    hint: "The gradient's second stop and the dashboard KPI band's seed hue. Hex format.",
  },
  {
    key: "primaryHoverColor",
    label: "Primary hover",
    placeholder: "#1d4ed8",
    hint: "The primary colour's hover/pressed state. Leave blank to compute one automatically.",
  },
  {
    key: "secondaryHoverColor",
    label: "Secondary hover",
    placeholder: "#020617",
    hint: "Saved with the palette for when a secondary-filled control needs it. Not yet drawn anywhere.",
  },
  {
    key: "textColor",
    label: "Text",
    placeholder: "#171717",
    hint: "Body copy across the whole console. Only applies when it stays readable in both light and dark mode.",
  },
  {
    key: "appBackgroundColor",
    label: "App background",
    placeholder: "#f8fafc",
    hint: "The page behind the console. Leave blank to keep the default.",
  },
] as const;

type ColorKey = (typeof COLORS)[number]["key"];

/** The five image fields. `kind` is the exact string the presigned-upload endpoint expects. */
const IMAGES = [
  {
    key: "logoUrl",
    kind: "logo",
    label: "Logo",
    hint: "Shown in the console sidebar and on the sign-in screen.",
  },
  {
    key: "faviconUrl",
    kind: "favicon",
    label: "Favicon",
    hint: "The small icon in the browser tab. A square PNG or ICO works best.",
  },
  {
    key: "sidebarIconUrl",
    kind: "sidebarIcon",
    label: "Collapsed sidebar icon",
    hint: "Shown in place of the logo once the sidebar is collapsed to an icon rail. Falls back to the logo above.",
  },
  {
    key: "bannerUrl",
    kind: "banner",
    label: "Banner",
    hint: "A wide image for the top of the console. Optional.",
  },
  {
    key: "loginBackgroundUrl",
    kind: "loginBackground",
    label: "Sign-in background",
    hint: "Saved for the sign-in screen. Not shown there yet - every workspace currently signs in at the same shared page.",
  },
] as const;

type ImageKey = (typeof IMAGES)[number]["key"];
type ImageKind = (typeof IMAGES)[number]["kind"];

const UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function paletteOf(form: BrandingView): Record<PaletteKey, string | null> {
  const out = {} as Record<PaletteKey, string | null>;
  for (const key of PALETTE_KEYS) {
    const v = form[key].trim();
    out[key] = v ? v : null;
  }
  return out;
}

/**
 * The white-label surface for one org.
 *
 * ── WHY THESE FIELDS ─────────────────────────────────────────────────────────
 *
 * Five images (logo, favicon, collapsed-sidebar icon, banner, sign-in
 * background - the last stored but not yet rendered, see branding.ts) and six
 * colours (primary/secondary, their hover states, text, and the app
 * background), plus saved palettes an admin can switch between in one click.
 * `secondaryColor`, `browserTitle` etc. keep their original names - see
 * branding.ts for why renaming an already-saved field is never worth it.
 *
 * ── ONLY CHANGED FIELDS ARE SENT ────────────────────────────────────────────
 *
 * PATCH /org/branding merges into the existing jsonb, so sending the whole
 * form would be harmless - but the diff keeps the request legible and matches
 * the rest of the console's PATCH actions. Colours are validated here against
 * the same `#rrggbb` regex the API enforces.
 *
 * ── UPLOADS ──────────────────────────────────────────────────────────────────
 *
 * Each image field accepts a pasted URL OR a dropped/picked file. A file goes
 * through `getBrandingUploadUrlAction` for a presigned S3 PUT, is sent
 * straight from the browser to storage, and the resulting URL is written into
 * the same text field an admin could have typed into by hand - so both paths
 * end up in the exact same place, validated the exact same way, before Save
 * is ever pressed.
 *
 * ── PRESETS ──────────────────────────────────────────────────────────────────
 *
 * A preset is a named snapshot of the six colour fields. Saving or deleting
 * one persists immediately (the list itself is the record, there is nothing to
 * "undo" a save of), while Apply loads a preset's colours into the form AND
 * saves them in the same action - "quickly toggle" means the console repaints
 * on the click, not on a second trip to the Save button below.
 *
 * ── FOUR TABS, NOT ONE LONG FORM ────────────────────────────────────────────
 *
 * Five images with an upload zone each, six colours, a preset manager and a
 * browser-title field used to be one page an admin scrolled through in full
 * every time, most of it irrelevant to whatever they actually came to change.
 * Same pattern LeadsTabs/InstanceTabs already use elsewhere in this console:
 * `hidden`, not a conditional render, so switching tabs never drops an
 * in-progress edit or a pending upload the way unmounting would. Save stays
 * OUTSIDE the panels because it commits Images + Colours + Browser together
 * as one diff against `initial` - moving it inside a tab would suggest each
 * tab saves independently, which is not how the patch below works.
 *
 * The tab bar itself is NOT sticky, unlike some panels elsewhere in the
 * console: <ConsoleHeader> above it is already `md:sticky md:top-0 z-20`
 * (console-header.tsx), and a second `top-0` sticky element lower in the same
 * document would fight it for the same pixel row the moment both are pinned -
 * this page's own scroll is short enough post-tabs that it does not need one.
 */
export function BrandingForm({ initial }: { initial: BrandingView }) {
  const [tab, setTab] = useState<TabId>("images");
  const [form, setForm] = useDraftState<BrandingView>(initial);
  const [presets, setPresets] = useDraftState<BrandingPreset[]>(initial.presets);
  const [presetName, setPresetName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [pending, startTransition] = useTransition();
  const [presetPending, startPresetTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const set = (key: keyof BrandingView, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const colorErrors = (values: BrandingView) => {
    const errors: Record<string, string> = {};
    for (const c of COLORS) {
      const v = values[c.key].trim();
      if (v && !HEX_COLOR.test(v)) errors[c.key] = `Enter a hex colour like ${c.placeholder}.`;
    }
    return errors;
  };

  const buildImagePatch = (values: BrandingView, base: BrandingView) => {
    const patch: BrandingPatch = {};
    for (const i of IMAGES) {
      const v = values[i.key].trim();
      // "" clears to null - the API reads that as "fall back to the default asset".
      if (v !== base[i.key]) patch[i.key as ImageKey] = v ? v : null;
    }
    return patch;
  };

  const buildColorPatch = (values: BrandingView, base: BrandingView) => {
    const patch: BrandingPatch = {};
    for (const c of COLORS) {
      const v = values[c.key].trim();
      if (v !== base[c.key]) patch[c.key as ColorKey] = v ? v : null;
    }
    return patch;
  };

  const save = () => {
    const errors = colorErrors(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const patch: BrandingPatch = { ...buildImagePatch(form, initial), ...buildColorPatch(form, initial) };
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

  const upload = (key: ImageKey, kind: ImageKind, file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      void alert({ title: "That file is too large", body: "Branding images are capped at 5 MB.", tone: "danger" });
      return;
    }
    setUploading((prev) => ({ ...prev, [key]: true }));
    startTransition(async () => {
      try {
        const result = await getBrandingUploadUrlAction(kind, file.type);
        if (result.error || !result.uploadUrl || !result.assetUrl) {
          await alert({
            title: "Couldn't start the upload",
            body: result.error ?? "The API didn't return an upload URL.",
            tone: "danger",
          });
          return;
        }
        const put = await fetch(result.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!put.ok) {
          await alert({ title: "Upload failed", body: `Storage answered ${put.status}.`, tone: "danger" });
          return;
        }
        set(key, result.assetUrl);
        toast("Uploaded - press Save to apply it");
      } finally {
        setUploading((prev) => ({ ...prev, [key]: false }));
      }
    });
  };

  const saveAsPreset = () => {
    const errors = colorErrors(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const name = presetName.trim();
    if (!name) return;

    const next: BrandingPreset[] = [
      ...presets,
      { id: crypto.randomUUID(), name, colors: paletteOf(form) },
    ];
    startPresetTransition(async () => {
      const result = await updateBrandingAction({ presets: next });
      if (result.error) {
        await alert({ title: "Couldn't save that preset", body: result.error, tone: "danger" });
        return;
      }
      setPresets(next);
      setPresetName("");
      toast(`Saved "${name}"`);
    });
  };

  const applyPreset = (preset: BrandingPreset) => {
    const next: BrandingView = { ...form };
    for (const key of PALETTE_KEYS) {
      next[key] = preset.colors[key] ?? "";
    }
    setForm(next);
    setFieldErrors({});

    const patch: BrandingPatch = buildColorPatch(next, initial);
    if (Object.keys(patch).length === 0) {
      // The preset matches what's already live - nothing to send.
      toast(`Applied "${preset.name}"`);
      return;
    }

    startTransition(async () => {
      const result = await updateBrandingAction(patch);
      if (result.error) {
        await alert({ title: "Couldn't apply that preset", body: result.error, tone: "danger" });
        return;
      }
      toast(`Applied "${preset.name}"`);
    });
  };

  const deletePreset = (preset: BrandingPreset) => {
    const next = presets.filter((p) => p.id !== preset.id);
    startPresetTransition(async () => {
      const result = await updateBrandingAction({ presets: next });
      if (result.error) {
        await alert({ title: "Couldn't remove that preset", body: result.error, tone: "danger" });
        return;
      }
      setPresets(next);
      toast(`Removed "${preset.name}"`);
    });
  };

  const swatch = (value: string) => (HEX_COLOR.test(value.trim()) ? value.trim() : "transparent");

  const textWarning =
    HEX_COLOR.test(form.textColor.trim()) && !isUsableTextColor(form.textColor.trim())
      ? "Too low-contrast to read in both light and dark mode - this won't be applied."
      : null;
  const backgroundWarning =
    HEX_COLOR.test(form.appBackgroundColor.trim()) && !isUsableAppBackground(form.appBackgroundColor.trim())
      ? "Too dark for the console's body text to stay readable on it - this won't be applied."
      : null;

  return (
    <div className="max-w-3xl space-y-5">
      <div role="tablist" aria-label="Branding" className="flex gap-1 border-b border-border">
        <Tab id="images" current={tab} onSelect={setTab}>
          Images
        </Tab>
        <Tab id="colours" current={tab} onSelect={setTab}>
          Colours
        </Tab>
        <Tab id="palettes" current={tab} onSelect={setTab}>
          Palettes{presets.length > 0 ? ` (${presets.length})` : ""}
        </Tab>
        <Tab id="browser" current={tab} onSelect={setTab}>
          Browser
        </Tab>
      </div>

      <div role="tabpanel" hidden={tab !== "images"} className="grid gap-4 sm:grid-cols-2">
        {IMAGES.map((i) => (
          <FormField key={i.key} label={i.label} name={i.key} hint={i.hint}>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={form[i.key]}
                  onChange={(e) => set(i.key, e.target.value)}
                  placeholder="https://example.com/image.png"
                  type="url"
                  className="flex-1"
                />
                {form[i.key].trim() ? (
                  // A raw <img>, not next/image, on purpose - the same reasoning
                  // @aura/ui's Logo gives: the source is an arbitrary URL (a
                  // tenant's own paste, or our own upload proxy), and next/image
                  // needs every host allowlisted at build time.
                  <img
                    src={form[i.key].trim()}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-md border border-border object-contain"
                  />
                ) : null}
              </div>
              <DropZone
                label={uploading[i.key] ? "Uploading…" : "Drop an image to upload"}
                accept={UPLOAD_ACCEPT}
                disabled={uploading[i.key] || pending}
                onFile={(file) => upload(i.key, i.kind, file)}
              />
            </div>
          </FormField>
        ))}
      </div>

      <div role="tabpanel" hidden={tab !== "colours"} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {COLORS.map((c) => {
            const warning = c.key === "textColor" ? textWarning : c.key === "appBackgroundColor" ? backgroundWarning : null;
            return (
              <FormField
                key={c.key}
                label={c.label}
                name={c.key}
                error={fieldErrors[c.key]}
                hint={fieldErrors[c.key] ? undefined : (warning ?? c.hint)}
              >
                <Input
                  value={form[c.key]}
                  onChange={(e) => set(c.key, e.target.value)}
                  placeholder={c.placeholder}
                />
              </FormField>
            );
          })}
        </div>

        <div>
          <p className="text-xs text-text-muted">Preview</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {COLORS.map((c) => (
              <div
                key={c.key}
                className="h-10 w-10 rounded-md border border-border-strong"
                style={{ backgroundColor: swatch(form[c.key]) }}
                title={form[c.key] || c.label}
              />
            ))}
          </div>
        </div>
      </div>

      <div role="tabpanel" hidden={tab !== "palettes"} className="space-y-3">
        <p className="text-xs text-text-muted">
          Save the colours on the Colours tab as a named pattern, then switch between saved patterns in
          one click.
        </p>

        {presets.length > 0 ? (
          <ul className="space-y-2">
            {presets.map((preset) => (
              <li
                key={preset.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex shrink-0 -space-x-1">
                    {PALETTE_KEYS.filter((k) => k === "primaryColor" || k === "secondaryColor" || k === "appBackgroundColor").map(
                      (k) => (
                        <div
                          key={k}
                          className="h-5 w-5 rounded-full border border-border-strong"
                          style={{ backgroundColor: swatch(preset.colors[k] ?? "") }}
                        />
                      ),
                    )}
                  </div>
                  <span className="truncate text-sm text-text">{preset.name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={presetPending || pending}
                    onClick={() => applyPreset(preset)}
                  >
                    Apply
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    loading={presetPending}
                    onClick={() => deletePreset(preset)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-text-muted">No saved palettes yet.</p>
        )}

        <div className="flex items-center gap-2">
          <Input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder="Palette name, e.g. Diwali campaign"
            className="flex-1"
          />
          <Button type="button" variant="secondary" loading={presetPending} onClick={saveAsPreset} disabled={!presetName.trim()}>
            Save current as preset
          </Button>
        </div>
      </div>

      <div role="tabpanel" hidden={tab !== "browser"}>
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
      </div>

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button type="button" loading={pending} onClick={save}>
          Save
        </Button>
        {/* Only present when it's true of MORE than the tab someone happens to
            be looking at - Save commits Images + Colours + Browser as one
            diff (see the component's own note on why), so it needs saying
            once here rather than once per tab. */}
        <p className="text-xs text-text-muted">Applies Images, Colours and Browser together.</p>
      </div>
    </div>
  );
}

function Tab({
  id,
  current,
  onSelect,
  children,
}: {
  id: TabId;
  current: TabId;
  onSelect: (id: TabId) => void;
  children: ReactNode;
}) {
  const active = current === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(id)}
      className={
        // -1px bottom margin so the active tab's underline sits ON the
        // container's border rather than above it - same as leads-tabs.tsx.
        "-mb-px h-10 rounded-t-md border-b-2 px-4 text-sm font-medium transition-colors " +
        (active ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text")
      }
    >
      {children}
    </button>
  );
}
