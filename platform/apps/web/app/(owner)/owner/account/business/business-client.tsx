"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button, Card, ErrorBanner, FormField, Input, Select, useToast } from "@aura/ui";
import {
  GST_STATES,
  GSTIN_PROBLEM_TEXT,
  MONTH_NAMES,
  gstinProblem,
  normaliseGstin,
  panFromGstin,
  timeZoneLabel,
  type BusinessProfile,
} from "@aura/shared";
import { saveBusinessProfileAction } from "../actions";

type Form = Record<
  | "displayName"
  | "legalName"
  | "tradeName"
  | "gstin"
  | "pan"
  | "addressLine1"
  | "addressLine2"
  | "city"
  | "postalCode"
  | "stateCode"
  | "country"
  | "baseCurrency"
  | "contactEmail"
  | "contactPhone"
  | "website",
  string
> & { fyStartMonth: number };

function formFrom(p: BusinessProfile): Form {
  return {
    displayName: p.displayName,
    legalName: p.legalName ?? "",
    tradeName: p.tradeName ?? "",
    gstin: p.gstin ?? "",
    pan: p.pan ?? "",
    addressLine1: p.addressLine1 ?? "",
    addressLine2: p.addressLine2 ?? "",
    city: p.city ?? "",
    postalCode: p.postalCode ?? "",
    stateCode: p.stateCode ?? "",
    country: p.country,
    baseCurrency: p.baseCurrency,
    fyStartMonth: p.fyStartMonth,
    contactEmail: p.contactEmail ?? "",
    contactPhone: p.contactPhone ?? "",
    website: p.website ?? "",
  };
}

const SECTION = "space-y-4 border-t border-border pt-5 first:border-t-0 first:pt-0";
const GRID = "grid gap-4 sm:grid-cols-2";

/**
 * The business profile form (doc 27 §4.3).
 *
 * A manager sees the same form, disabled, with the reason - roles.ts puts a
 * business's identity with billing and branding, which managers do not edit.
 * The API is what refuses them; this only avoids offering a Save that 403s.
 *
 * GSTIN is checked here as you type (format, checksum, and that its first two
 * digits are the chosen state's code) with the same function the API runs, so
 * the form and the server can never disagree about what is valid. With a GSTIN
 * the PAN is characters 3-12 of it, filled in and locked.
 */
export function BusinessProfileForm({
  profile,
  canEdit,
  logoUrl,
}: {
  profile: BusinessProfile;
  canEdit: boolean;
  logoUrl: string | null;
}) {
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => formFrom(profile));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const india = form.country.trim().toUpperCase() === "IN";
  const gstin = normaliseGstin(form.gstin);
  const liveGstinProblem = gstin ? gstinProblem(gstin, india && form.stateCode ? form.stateCode : null) : null;
  const derivedPan = gstin ? panFromGstin(gstin) : null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});
    setError(null);
    startTransition(async () => {
      const result = await saveBusinessProfileAction({
        ...form,
        gstin: gstin || null,
        pan: derivedPan ?? (form.pan.trim() || null),
        country: form.country.trim().toUpperCase(),
        baseCurrency: form.baseCurrency.trim().toUpperCase(),
        stateCode: india ? form.stateCode || null : null,
      });
      if (result.fieldErrors) setErrors(result.fieldErrors);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.profile) setForm(formFrom(result.profile));
      toast("Business profile saved");
    });
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-6">
        {!canEdit ? (
          <p className="rounded-md border border-border bg-surface-hover px-3 py-2 text-sm text-text-muted">
            Only an owner can change the business profile.
          </p>
        ) : null}

        <fieldset disabled={!canEdit || pending} className="space-y-6">
          <section className={SECTION}>
            <h2 className="text-base font-semibold text-text">Identity</h2>
            <div className={GRID}>
              <FormField
                label="Display name"
                name="displayName"
                required
                hint="Shown in the sidebar and the workspace switcher."
                error={errors.displayName}
              >
                <Input value={form.displayName} onChange={(e) => set("displayName", e.target.value)} maxLength={120} />
              </FormField>
              <FormField
                label="Legal name"
                name="legalName"
                hint="As registered. Needed to finish setting up."
                error={errors.legalName}
              >
                <Input value={form.legalName} onChange={(e) => set("legalName", e.target.value)} maxLength={200} />
              </FormField>
              <FormField label="Trade name" name="tradeName" error={errors.tradeName}>
                <Input value={form.tradeName} onChange={(e) => set("tradeName", e.target.value)} maxLength={200} />
              </FormField>
            </div>
          </section>

          <section className={SECTION}>
            <h2 className="text-base font-semibold text-text">Registration</h2>
            <div className={GRID}>
              <FormField
                label="GSTIN"
                name="gstin"
                hint="Optional - leave it empty if the business is not GST-registered."
                error={errors.gstin ?? (liveGstinProblem ? GSTIN_PROBLEM_TEXT[liveGstinProblem] : undefined)}
              >
                <Input
                  value={form.gstin}
                  onChange={(e) => set("gstin", e.target.value.toUpperCase())}
                  maxLength={20}
                  className="font-mono uppercase"
                  placeholder="27ABCDE1234F1Z5"
                  disabled={!india}
                />
              </FormField>
              <FormField
                label="PAN"
                name="pan"
                hint={derivedPan ? "Taken from the GSTIN." : undefined}
                error={errors.pan}
              >
                <Input
                  value={derivedPan ?? form.pan}
                  onChange={(e) => set("pan", e.target.value.toUpperCase())}
                  maxLength={10}
                  className="font-mono uppercase"
                  readOnly={Boolean(derivedPan)}
                  disabled={!india}
                />
              </FormField>
            </div>
          </section>

          <section className={SECTION}>
            <h2 className="text-base font-semibold text-text">Address</h2>
            <div className={GRID}>
              <FormField label="Address line 1" name="addressLine1" error={errors.addressLine1}>
                <Input value={form.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} maxLength={200} />
              </FormField>
              <FormField label="Address line 2" name="addressLine2" error={errors.addressLine2}>
                <Input value={form.addressLine2} onChange={(e) => set("addressLine2", e.target.value)} maxLength={200} />
              </FormField>
              <FormField label="City" name="city" error={errors.city}>
                <Input value={form.city} onChange={(e) => set("city", e.target.value)} maxLength={100} />
              </FormField>
              <FormField label="Postal code" name="postalCode" error={errors.postalCode}>
                <Input value={form.postalCode} onChange={(e) => set("postalCode", e.target.value)} maxLength={20} />
              </FormField>
              <FormField
                label="State"
                name="stateCode"
                required={india}
                hint={india ? "Needed to finish setting up." : "Only used for a business in India."}
                error={errors.stateCode}
              >
                <Select value={form.stateCode} onChange={(e) => set("stateCode", e.target.value)} disabled={!india}>
                  <option value="">Choose a state</option>
                  {GST_STATES.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Country" name="country" hint="Two letters, like IN." error={errors.country}>
                <Input
                  value={form.country}
                  onChange={(e) => set("country", e.target.value.toUpperCase())}
                  maxLength={2}
                  className="font-mono uppercase"
                />
              </FormField>
            </div>
          </section>

          <section className={SECTION}>
            <h2 className="text-base font-semibold text-text">Contact</h2>
            <p className="text-sm text-text-muted">
              Printed on your documents. Aura never sends anything to these.
            </p>
            <div className={GRID}>
              <FormField label="Business email" name="contactEmail" error={errors.contactEmail}>
                <Input
                  type="email"
                  value={form.contactEmail}
                  onChange={(e) => set("contactEmail", e.target.value)}
                  maxLength={320}
                />
              </FormField>
              <FormField label="Business phone" name="contactPhone" error={errors.contactPhone}>
                <Input
                  type="tel"
                  value={form.contactPhone}
                  onChange={(e) => set("contactPhone", e.target.value)}
                  maxLength={32}
                />
              </FormField>
              <FormField label="Website" name="website" error={errors.website}>
                <Input value={form.website} onChange={(e) => set("website", e.target.value)} maxLength={300} />
              </FormField>
            </div>
          </section>

          <section className={SECTION}>
            <h2 className="text-base font-semibold text-text">Regional</h2>
            <div className={GRID}>
              {/* Read-only here. The zone has its own page (Build docs/30), which a
                  manager can also use, and a form that re-sent the zone it loaded
                  with would let an old tab undo a change made there. */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-text">Time zone</p>
                <p className="text-sm text-text">{timeZoneLabel(profile.timezone)}</p>
                <p className="text-xs text-text-muted">
                  Every time in the console, and where each day starts.{" "}
                  <Link href="/owner/account/time" className="font-medium text-text underline-offset-2 hover:underline">
                    Change time zone
                  </Link>
                </p>
              </div>
              <FormField label="Base currency" name="baseCurrency" hint="Three letters, like INR." error={errors.baseCurrency}>
                <Input
                  value={form.baseCurrency}
                  onChange={(e) => set("baseCurrency", e.target.value.toUpperCase())}
                  maxLength={3}
                  className="font-mono uppercase"
                />
              </FormField>
              <FormField label="Financial year starts in" name="fyStartMonth" error={errors.fyStartMonth}>
                <Select value={String(form.fyStartMonth)} onChange={(e) => set("fyStartMonth", Number(e.target.value))}>
                  {MONTH_NAMES.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
          </section>
        </fieldset>

        <section className={SECTION}>
          <h2 className="text-base font-semibold text-text">Logo</h2>
          <div className="flex items-center gap-3">
            {logoUrl ? (
              // A tenant-supplied URL on an arbitrary host: a bare <img>, as
              // the Logo component explains.
              <img src={logoUrl} alt="" className="h-10 w-10 rounded-md border border-border object-contain" />
            ) : null}
            <p className="text-sm text-text-muted">
              {logoUrl ? "Your logo is managed on " : "No logo yet. Add one on "}
              <Link href="/owner/branding" className="font-medium text-text underline underline-offset-2">
                Branding
              </Link>
              .
            </p>
          </div>
        </section>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {canEdit ? (
          <Button type="submit" loading={pending} disabled={Boolean(liveGstinProblem)}>
            Save business profile
          </Button>
        ) : null}
      </form>
    </Card>
  );
}
