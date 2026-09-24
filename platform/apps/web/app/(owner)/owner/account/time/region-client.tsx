"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Card, ErrorBanner, FormField, MonoLabel, Select, useToast } from "@aura/ui";
import type { CurrencyOption } from "@/lib/region-options";
import { saveRegionAction } from "../actions";

export interface CountryOption {
  iso: string;
  name: string;
  dial: string;
}

/**
 * The location half of Time & location: the workspace's country and currency.
 *
 * The country is where every phone field in the console starts - "+91" for
 * India - and the currency is the one the business works in. Both are the
 * business profile's own columns (0126); this is now the one place they are
 * edited, the way the zone above is.
 *
 * Owner only. A manager sees the values, and why they cannot change them,
 * rather than a form that fails on save.
 */
export function RegionSettings({
  current,
  countries,
  currencies,
  canEdit,
}: {
  current: { country: string; currency: string };
  countries: CountryOption[];
  currencies: CurrencyOption[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState(current);
  const [country, setCountry] = useState(current.country);
  const [currency, setCurrency] = useState(current.currency);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A save revalidates the layout; the new values arrive from the server.
  useEffect(() => {
    setSaved(current);
    setCountry(current.country);
    setCurrency(current.currency);
  }, [current.country, current.currency]);

  const byIso = (iso: string) => countries.find((c) => c.iso === iso);
  const currencyName = (code: string) => currencies.find((c) => c.code === code)?.name ?? code;
  // A stored code the list no longer offers still has to show as selected.
  const currencyList = currencies.some((c) => c.code === saved.currency)
    ? currencies
    : [{ code: saved.currency, name: saved.currency }, ...currencies];

  const savedCountry = byIso(saved.country);
  const nextCountry = byIso(country);
  const countryChanged = country !== saved.country;
  const currencyChanged = currency !== saved.currency;
  const dirty = countryChanged || currencyChanged;

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveRegionAction({ country, currency });
      if (result.error) {
        setError(result.fieldErrors?.country ?? result.fieldErrors?.currency ?? result.error);
        return;
      }
      const next = { country: result.country ?? country, currency: result.currency ?? currency };
      setSaved(next);
      toast(`Location set to ${byIso(next.country)?.name ?? next.country} · ${next.currency}`);
    });
  };

  return (
    <Card className="space-y-5">
      <div className="space-y-1">
        <MonoLabel>Workspace location</MonoLabel>
        <p className="text-3xl font-semibold text-text">
          {savedCountry?.name ?? saved.country}
          <span className="ml-2 text-xl font-normal text-text-muted tabular-nums">{savedCountry?.dial}</span>
        </p>
        <p className="text-sm text-text-muted">
          {currencyName(saved.currency)} · {saved.currency}
        </p>
      </div>

      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <FormField
          label="Default country"
          name="country"
          hint="Every phone field starts on this country's code. Anyone can still pick another country for a number."
        >
          <Select
            value={country}
            disabled={!canEdit || pending}
            onChange={(e) => {
              setCountry(e.target.value);
              setError(null);
            }}
          >
            {countries.map((c) => (
              <option key={c.iso} value={c.iso}>
                {c.name} ({c.dial})
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Currency" name="currency" hint="The currency this business works in.">
          <Select
            value={currency}
            disabled={!canEdit || pending}
            onChange={(e) => {
              setCurrency(e.target.value);
              setError(null);
            }}
          >
            {currencyList.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      {!canEdit ? (
        <p className="text-sm text-text-muted">
          Only the workspace owner can change the country and currency. They are part of the business&rsquo;s identity,
          with its legal name and GSTIN.
        </p>
      ) : null}

      {canEdit && dirty ? (
        <div className="space-y-3 rounded-md border border-border bg-bg-subtle p-4" aria-live="polite">
          <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
            {countryChanged && nextCountry ? (
              <>
                <li>
                  New phone numbers will start on{" "}
                  <span className="font-medium text-text">
                    {nextCountry.name} ({nextCountry.dial})
                  </span>{" "}
                  instead of {savedCountry?.name ?? saved.country} ({savedCountry?.dial}).
                </li>
                <li>Numbers already saved keep their own country code.</li>
                {country !== "IN" ? (
                  <li>The GST state on your business profile is cleared - it only applies in India.</li>
                ) : null}
              </>
            ) : null}
            {currencyChanged ? (
              <li>
                The business currency becomes{" "}
                <span className="font-medium text-text">
                  {currencyName(currency)} ({currency})
                </span>
                . Quotes and invoices already written keep the currency they were written in.
              </li>
            ) : null}
          </ul>
          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save location"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setCountry(saved.country);
                setCurrency(saved.currency);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
