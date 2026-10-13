"use client";

import { useState, useTransition } from "react";
import { Button, Card, ProgressBar, Select, StatusChip } from "@aura/ui";
import { formatBytes } from "@aura/shared";
import { formatMoney } from "../../lib/format-money";
import {
  buyTopupAction,
  setAutoTopupAction,
  startCheckoutAction,
  type CheckoutOutcome,
} from "./billing-actions";

/**
 * The capture price list, the four meters against it, and the two buttons
 * (migration 0197).
 *
 * ── THE WORDING IS THE FEATURE ──────────────────────────────────────────────
 *
 * No countdown, no hidden cost, no dark pattern - the same rule the API tier's
 * plan page follows. The practical consequences are in the copy:
 *
 *   * tax is always shown, because the price list quotes ex-tax and a total
 *     that appears for the first time at checkout is the thing people
 *     complain about;
 *   * "Talk to us" for Enterprise and for a region we cannot sell in, never a
 *     button that fails after the click;
 *   * a limit is described by what it DOES - "calls are still recorded" - so
 *     nobody reads a full meter as an outage;
 *   * "we'll invoice you" when there is no gateway, which is the truth rather
 *     than an error.
 */

interface Meter {
  state: "ok" | "warning" | "grace" | "blocked";
  fraction: number | null;
  limit: number | null;
  used: number;
  remaining: number | null;
}

export interface BillingOverview {
  region: "IN" | "AE";
  currency: string;
  period: "annual" | "monthly";
  plan: {
    key: string | null;
    name: string | null;
    family: string | null;
    status: string | null;
    billingPeriod: string;
  };
  meters: {
    handsets: Meter;
    transcriptionMinutes: Meter;
    storageBytes: Meter;
    audioRetentionDays: number | null;
    includedHours: number | null;
    toppedUpHours: number;
  };
  features: { speakerSeparation: boolean; aiAnalysis: boolean; transcriptionAllowed: boolean };
  recordingProhibited: boolean;
  addons: { key: string; units: number; name: string }[];
  autoTopup: {
    enabled: boolean;
    addonKey: string | null;
    capMinor: number | null;
    defaultCapMinor: number;
  };
  plans: {
    key: string;
    name: string;
    blurb: string;
    handsets: number;
    transcriptionHours: number | null;
    audioRetentionDays: number;
    storageCapGb: number | null;
    speakerSeparation: boolean;
    aiAnalysis: boolean;
    negotiated: boolean;
    fromPrice: boolean;
    currency: string;
    priceMinor: number;
    taxMinor: number;
    totalMinor: number;
    taxLabel: string;
    chargeable: boolean;
    blockedReason: string | null;
  }[];
  topups: {
    key: string;
    name: string;
    kind: "pack" | "recurring";
    grant: number;
    entitlement: string;
    priceMinor: number;
    maxUnits: number;
  }[];
  limitBehaviours: { entitlement: string; label: string; notice: string }[];
}

/** Minor units to a display string. Every amount from this API is minor units. */
function money(minor: number, currency: string): string {
  return formatMoney(minor / 100, currency);
}

function meterTone(state: Meter["state"]): "solid" | "danger" {
  // Orange at or past the limit, never red: red means MISSED in this console,
  // and nothing here is an error - a full meter is a plan doing its job.
  return state === "ok" || state === "warning" ? "solid" : "danger";
}

function Outcome({ outcome }: { outcome: CheckoutOutcome | null }) {
  if (!outcome) return null;
  if (outcome.error) return <p className="text-sm text-danger">{outcome.error}</p>;
  if (outcome.gateway === "manual") {
    return (
      <p className="text-sm text-text">
        {outcome.gatewayReason === "currency_unsupported"
          ? "We'll invoice you for this - your currency is settled outside our online gateway."
          : "We'll invoice you for this. Nothing has been charged and nothing has changed on your plan yet."}{" "}
        {outcome.totalMinor !== undefined && outcome.currency
          ? `Amount: ${money(outcome.totalMinor, outcome.currency)}.`
          : null}
      </p>
    );
  }
  return (
    <p className="text-sm text-text">
      Payment started
      {outcome.totalMinor !== undefined && outcome.currency
        ? ` for ${money(outcome.totalMinor, outcome.currency)}`
        : ""}
      . Your plan changes once the payment clears.
    </p>
  );
}

export function CapturePlans({ overview }: { overview: BillingOverview }) {
  const [period, setPeriod] = useState<"annual" | "monthly">(
    (overview.plan.billingPeriod as "annual" | "monthly") ?? "annual",
  );
  const [outcome, setOutcome] = useState<CheckoutOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const [topupKey, setTopupKey] = useState(overview.topups[0]?.key ?? "");
  const [topupUnits, setTopupUnits] = useState(1);

  const [autoOn, setAutoOn] = useState(overview.autoTopup.enabled);
  const [autoCap, setAutoCap] = useState(
    String((overview.autoTopup.capMinor ?? overview.autoTopup.defaultCapMinor) / 100),
  );

  const chosenTopup = overview.topups.find((t) => t.key === topupKey);

  function checkout(planKey: string) {
    setOutcome(null);
    startTransition(async () => {
      setOutcome(await startCheckoutAction({ planKey, period }));
    });
  }

  function topup() {
    if (!chosenTopup) return;
    setOutcome(null);
    startTransition(async () => {
      setOutcome(await buyTopupAction({ addonKey: chosenTopup.key, units: topupUnits }));
    });
  }

  function saveAuto(next: boolean) {
    setOutcome(null);
    const cap = Math.round(Number(autoCap) * 100);
    startTransition(async () => {
      const result = await setAutoTopupAction(
        next
          ? { enabled: true, addonKey: "topup_hours_25", capMinor: cap > 0 ? cap : undefined }
          : { enabled: false },
      );
      if (result.error) setOutcome({ error: result.error });
      else setAutoOn(next);
    });
  }

  const hours = overview.meters.transcriptionMinutes;
  const handsets = overview.meters.handsets;

  // An Insights tenant is served an empty price list by the API, because that
  // is a different product with its own rail at /owner/plan. Drawing the
  // meters and the top-up picker for them would offer to sell handset capacity
  // to somebody with no handsets, so the whole component steps aside.
  if (overview.plans.length === 0) return null;

  return (
    <>
      {/* ── The one notice that is NOT about money ──────────────────────────
          A tenant in a region we cannot sell in records nothing, and the
          reason is the law rather than a fault. Saying so is the difference
          between a support ticket and an understood constraint. */}
      {overview.recordingProhibited ? (
        <Card className="space-y-2">
          <h2 className="text-base font-semibold text-text">Recording is switched off</h2>
          <p className="text-sm text-text-muted">
            In your country, recording a call requires the other party&apos;s consent, and an
            announcement on its own is not enough. Your handsets will not record until we can
            capture that consent and your account manager has the paperwork in place.
          </p>
        </Card>
      ) : null}

      <Card className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-text">
            {overview.plan.name ? `You're on ${overview.plan.name}` : "Choose a plan"}
          </h2>
          <Select
            aria-label="Billing period"
            value={period}
            onChange={(e) => setPeriod(e.target.value as "annual" | "monthly")}
          >
            <option value="annual">Billed annually</option>
            <option value="monthly">Billed monthly</option>
          </Select>
        </div>
        {period === "monthly" ? (
          <p className="text-xs text-text-muted">
            Monthly billing costs about 20% more than the same plan on an annual commitment.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {overview.plans.map((plan) => {
            const current = plan.key === overview.plan.key;
            return (
              <div
                key={plan.key}
                className="space-y-3 rounded-lg border border-border p-4"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-text">{plan.name}</h3>
                  {current ? <StatusChip tone="muted">Your plan</StatusChip> : null}
                </div>
                <p className="text-2xl font-semibold text-text">
                  {plan.fromPrice ? "from " : ""}
                  {money(plan.priceMinor, plan.currency)}
                  <span className="text-sm font-normal text-text-muted">/month</span>
                </p>
                {/* Tax always visible. The price list quotes ex-tax, and a
                    total that first appears at checkout is the complaint. */}
                <p className="text-xs text-text-muted">
                  + {plan.taxLabel} {money(plan.taxMinor, plan.currency)} ={" "}
                  {money(plan.totalMinor, plan.currency)} a month
                </p>
                <p className="text-sm text-text-muted">{plan.blurb}</p>
                <ul className="space-y-1 text-sm text-text-muted">
                  <li>{plan.handsets} handsets{plan.negotiated ? " or more" : ""}</li>
                  <li>
                    {plan.transcriptionHours === null
                      ? "Transcription hours to suit"
                      : plan.transcriptionHours === 0
                        ? "No transcription"
                        : `${plan.transcriptionHours} transcription hours a month`}
                  </li>
                  <li>Audio kept {plan.audioRetentionDays} days</li>
                  <li>
                    {plan.storageCapGb === null
                      ? "Storage to suit"
                      : `${plan.storageCapGb} GB of recordings`}
                  </li>
                  <li>
                    {plan.speakerSeparation ? "Speaker labels and talk time" : "No speaker labels"}
                  </li>
                </ul>
                {current ? null : plan.chargeable ? (
                  <Button size="sm" onClick={() => checkout(plan.key)} disabled={pending}>
                    Choose {plan.name}
                  </Button>
                ) : (
                  // Never a button that fails after the click. A negotiated
                  // tier and an unsellable region are both "talk to us", and
                  // the second one says why.
                  <p className="text-sm text-text">
                    {plan.blockedReason === "region_not_sellable"
                      ? "Not available for online purchase in your country yet - your account manager will quote it."
                      : "Talk to us and we'll quote this for your floor."}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <Outcome outcome={outcome} />
      </Card>

      {/* ── The four meters, and what each one does when it is reached ───── */}
      <Card className="space-y-4">
        <h2 className="text-base font-semibold text-text">What you&apos;re using</h2>

        <div className="space-y-2">
          <p className="text-sm text-text">
            Handsets: {handsets.used} of {handsets.limit ?? "unlimited"}
          </p>
          {handsets.fraction !== null ? (
            <ProgressBar percent={handsets.fraction * 100} tone={meterTone(handsets.state)} />
          ) : null}
          {handsets.state === "blocked" ? (
            <p className="text-xs text-text">
              Pairing another phone will be refused. Add an extra handset below, or remove one you
              no longer use.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <p className="text-sm text-text">
            Transcription: {Math.round(hours.used / 60)} of{" "}
            {hours.limit === null ? "unlimited" : Math.round(hours.limit / 60)} hours this month
            {overview.meters.toppedUpHours > 0
              ? ` (including ${overview.meters.toppedUpHours} topped up)`
              : ""}
          </p>
          {hours.fraction !== null ? (
            <ProgressBar percent={hours.fraction * 100} tone={meterTone(hours.state)} />
          ) : null}
          <p className="text-xs text-text-muted">
            Past the limit your calls are still recorded, stored and playable - only transcription
            and analysis pause, and they are picked up automatically after a top-up or on the 1st.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-text">
            Recordings: {formatBytes(overview.meters.storageBytes.used)} of{" "}
            {overview.meters.storageBytes.limit === null
              ? "unlimited"
              : formatBytes(overview.meters.storageBytes.limit)}
          </p>
          {overview.meters.storageBytes.fraction !== null ? (
            <ProgressBar
              percent={overview.meters.storageBytes.fraction * 100}
              tone={meterTone(overview.meters.storageBytes.state)}
            />
          ) : null}
          <p className="text-xs text-text-muted">
            Uploads are never blocked. At the ceiling the oldest audio is removed first.
          </p>
        </div>

        {overview.meters.audioRetentionDays !== null ? (
          <p className="text-sm text-text-muted">
            Audio is kept {overview.meters.audioRetentionDays} days, then the recording file is
            deleted. Transcripts, insights and every CRM record stay.
          </p>
        ) : null}

        {overview.addons.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {overview.addons.map((addon) => (
              <StatusChip key={addon.key} tone="muted">
                {addon.name} x{addon.units}
              </StatusChip>
            ))}
          </div>
        ) : null}
      </Card>

      {/* ── Top-ups ──────────────────────────────────────────────────────── */}
      <Card className="space-y-3">
        <h2 className="text-base font-semibold text-text">Add more</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            aria-label="What to add"
            value={topupKey}
            onChange={(e) => {
              setTopupKey(e.target.value);
              setTopupUnits(1);
            }}
          >
            {overview.topups.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name} - {money(t.priceMinor, overview.currency)}
                {t.kind === "recurring" ? " a month" : ""}
              </option>
            ))}
          </Select>
          <Select
            aria-label="How many"
            value={String(topupUnits)}
            onChange={(e) => setTopupUnits(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                x{n}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={topup} disabled={pending || !chosenTopup}>
            Add
          </Button>
        </div>
        {chosenTopup ? (
          <p className="text-xs text-text-muted">
            {money(chosenTopup.priceMinor * topupUnits, overview.currency)} plus tax
            {chosenTopup.kind === "recurring"
              ? ", added to every month's bill until you remove it."
              : ", a one-off for this month."}{" "}
            {chosenTopup.kind === "pack"
              ? "Hour packs cost more per hour than the same hours inside a plan - if you top up every month, moving up a tier is cheaper."
              : null}
          </p>
        ) : null}

        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm text-text">Buy hours automatically when I run out</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={autoOn}
                onChange={(e) => saveAuto(e.target.checked)}
                disabled={pending}
              />
              Switched on
            </label>
            <label className="text-sm text-text-muted">
              Never spend more than{" "}
              <input
                className="w-28 rounded border border-border bg-surface px-2 py-1 text-text"
                inputMode="decimal"
                value={autoCap}
                onChange={(e) => setAutoCap(e.target.value)}
                aria-label="Monthly ceiling"
              />{" "}
              a month
            </label>
            {autoOn ? (
              <Button size="sm" variant="secondary" onClick={() => saveAuto(true)} disabled={pending}>
                Save ceiling
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-text-muted">
            Off unless you switch it on, and it never spends past the ceiling you set here.
          </p>
        </div>
      </Card>
    </>
  );
}
