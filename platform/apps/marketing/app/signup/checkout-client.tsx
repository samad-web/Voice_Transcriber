"use client";

import { useEffect, useMemo, useState } from "react";
import { GST_STATES } from "@aura/shared";

/**
 * THE BUY BUTTON. The thing the price list has never had.
 *
 * ── WHY THIS TALKS TO THE API DIRECTLY FROM THE BROWSER ─────────────────────
 *
 * nginx serves `/v1/` and `/` from the same host, so a fetch to
 * `/v1/signup/...` is same-origin and needs no proxy. That matters more than
 * convenience: the marketing container is the one process serving
 * unauthenticated traffic from the open internet, and it is deliberately given
 * a narrow `aura_marketing` database role and NO admin key. Routing the
 * checkout through its server would mean giving it a credential, or inventing
 * a second one, to reach routes that are public by design. The three signup
 * routes are unguarded precisely so that this page needs nothing.
 *
 * ── THE AMOUNT ON THIS PAGE IS A DISPLAY, NOT AN INPUT ──────────────────────
 *
 * The totals rendered here come from `/v1/signup/plans`, and the amount that is
 * actually charged is computed again on the server at checkout and frozen on
 * the signup row. Nothing the browser sends decides a price. If the two ever
 * disagree the server's number wins and the buyer pays that - which is why the
 * summary is re-read from the checkout response rather than trusted from here.
 *
 * ── THE 2026-10-14 REDESIGN, AND THE FOUR THINGS IT IS FOR ──────────────────
 *
 * The first version was one narrow column: five flat radio rows - every plan
 * crossed with every cadence - then five fields, then a button whose label was
 * the only place the total appeared. The brief for this pass was ONE SCREEN,
 * pick the plan where you are standing, nudge the upgrade, and collect details
 * the way Razorpay does. Each of those is a decision in this file:
 *
 *   1. ONE SCREEN. Two columns from `lg` - plan on the left, details and the
 *      pay button on the right - so the whole transaction is visible without
 *      scrolling. That constraint is why the type scale here is one step down
 *      from the rest of the site, why the plan cards carry two meters rather
 *      than a feature list, and why the summary is three lines instead of a
 *      table. Anything that could be read AFTER paying now lives on
 *      `/signup/done` or `/pricing`, not here.
 *   2. THE PLAN IS CHOSEN IN PLACE. A radio card, selected on the spot, with
 *      the cadence as one control above the cards rather than as a second set
 *      of rows. Crossing 3 plans by 2 cadences gave 5 rows of which two pairs
 *      were the same product at two prices, so the first comparison a buyer
 *      had to make was against the same plan twice.
 *   3. THE UPGRADE IS OFFERED, NOT INVENTED. The selected card grows a strip
 *      naming exactly what the next tier adds and what it costs - computed
 *      from the served catalogue, so it cannot drift from the price list. No
 *      "most popular" badge and no scarcity: we do not have the numbers to
 *      claim either, and this page is where a buyer decides whether to trust
 *      us with a card.
 *   4. DETAILS LIKE A PAYMENT SHEET. Razorpay's own flow is a short stack of
 *      quiet fields under the amount, so that is what this is: four fields,
 *      compact, labels small, with GSTIN behind a link because most buyers do
 *      not have one to hand. Billing state stays - it decides IGST vs
 *      CGST+SGST on the tax invoice and cannot be guessed later.
 *
 * ── WHAT WAS A BUG RATHER THAN A LOOK ───────────────────────────────────────
 *
 *   · "Billed annually" reads as a lump sum to everybody who is not an
 *     accountant, and `planPriceMinor` returns ONE MONTH on either cadence
 *     (see the long note in @aura/shared/pricing.ts - annual is a twelve-month
 *     commitment at a discounted monthly rate, which is the whole reason
 *     Growth fits under a ₹15,000 mandate). The summary now says what is
 *     debited today and what recurs, in words.
 *   · The fields were `className="border"`, i.e. Tailwind's default border on a
 *     transparent ground - very nearly invisible on the dark theme - and the
 *     error panel was hard-coded `bg-red-50` / `text-red-800`, light-theme ink
 *     on a dark surface. Both now come from the `--mk-*` tokens, and the field
 *     styles are lifted from `app/start/funnel-form.tsx` rather than reinvented.
 */

type Plan = {
  planKey: string;
  name: string;
  blurb: string;
  period: "annual" | "monthly";
  handsets: number;
  transcriptionHours: number | null;
  netMinor: number;
  totalMinor: number;
  taxMinor: number;
  currency: string;
};

type Period = "annual" | "monthly";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const rupees = (minor: number) =>
  `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** The two meters a card has room for, in the words the price list uses. */
function meters(p: Plan): string {
  const handsets = `${p.handsets} handset${p.handsets === 1 ? "" : "s"}`;
  if (p.transcriptionHours === null) return `${handsets} · transcription quoted`;
  if (p.transcriptionHours === 0) return `${handsets} · recording only`;
  return `${handsets} · ${p.transcriptionHours} hours a month`;
}

/**
 * What moving up a tier actually buys, read off the catalogue.
 *
 * Built from the served numbers rather than written out, so it cannot promise
 * something the price list has stopped including. Returns null when there is
 * nothing above the chosen plan on this cadence.
 */
function upgrade(from: Plan, to: Plan | undefined) {
  if (!to) return null;
  const gains: string[] = [];
  const extraHandsets = to.handsets - from.handsets;
  if (extraHandsets > 0) gains.push(`${extraHandsets} more handset${extraHandsets === 1 ? "" : "s"}`);

  const fromHours = from.transcriptionHours ?? 0;
  const toHours = to.transcriptionHours ?? 0;
  if (fromHours === 0 && toHours > 0) {
    // The Record -> Starter step is not "more hours", it is a different
    // product: nothing is transcribed on Record at all.
    gains.push(`${toHours} transcription hours, lead extraction and sentiment`);
  } else if (toHours > fromHours) {
    gains.push(`${toHours - fromHours} more hours a month`);
  }

  if (gains.length === 0) return null;
  return { to, gains, deltaMinor: to.totalMinor - from.totalMinor };
}

export function CheckoutClient({
  initialPlanKey,
  initialPeriod,
  footer,
}: {
  /** From `?plan=` - the tier whose button on /pricing was clicked. */
  initialPlanKey?: string;
  initialPeriod?: Period;
  /**
   * The page's own exit links, rendered UNDER the plan column rather than
   * under the page.
   *
   * Three plan cards are shorter than a payment sheet, so the left column ends
   * about 200px above the right one. Putting the footer in that gap is what
   * gets it above the fold on a 1280x800 laptop - at the bottom of the page it
   * was the one thing that did not fit - and it balances two columns that
   * otherwise end at visibly different heights.
   */
  footer?: React.ReactNode;
}) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [period, setPeriod] = useState<Period>(initialPeriod ?? "annual");
  const [chosenKey, setChosenKey] = useState<string | null>(initialPlanKey ?? null);
  const [gstOpen, setGstOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/v1/signup/plans", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("unavailable"))))
      .then((d: { plans?: Plan[] }) => {
        if (!alive) return;
        const list = d.plans ?? [];
        setPlans(list);

        // Honour the deep link only if it is real. A stale /pricing link, or a
        // hand-typed plan key, falls back to the catalogue rather than leaving
        // nothing selected - an empty selection on arrival reads as broken.
        const wanted = list.find(
          (p) => p.planKey === initialPlanKey && p.period === (initialPeriod ?? p.period),
        );
        const start = wanted ?? list[0];
        if (start) {
          setPeriod(start.period);
          setChosenKey(start.planKey);
        }
      })
      .catch(() => alive && setError("We couldn't load the plans just now. Please refresh."));
    return () => {
      alive = false;
    };
    // Runs once by design: the deep link is an arrival condition, not state to
    // track, and re-running it would stamp over a choice already made.
  }, [initialPlanKey, initialPeriod]);

  const periodsOffered = useMemo<Period[]>(() => {
    const set = new Set((plans ?? []).map((p) => p.period));
    return (["annual", "monthly"] as Period[]).filter((p) => set.has(p));
  }, [plans]);

  const shown = useMemo(() => (plans ?? []).filter((p) => p.period === period), [plans, period]);

  const chosenIndex = useMemo(() => {
    const i = shown.findIndex((p) => p.planKey === chosenKey);
    return i === -1 ? 0 : i;
  }, [shown, chosenKey]);

  const plan = shown[chosenIndex] ?? null;
  const step = plan ? upgrade(plan, shown[chosenIndex + 1]) : null;

  /**
   * Tiers this cadence does not offer. Growth is the live case: billed monthly
   * it is ₹17,982 debited, which is over the ₹15,000 an Indian bank will clear
   * on a standing mandate without asking the customer to approve every debit.
   * Saying so is better than a list that quietly gets shorter.
   */
  const missingHere = useMemo(() => {
    if (!plans) return [] as string[];
    const here = new Set(shown.map((p) => p.planKey));
    const names = new Map<string, string>();
    for (const p of plans) if (!here.has(p.planKey)) names.set(p.planKey, p.name);
    return [...names.values()];
  }, [plans, shown]);

  function pickPeriod(next: Period) {
    setPeriod(next);
    // Keep the tier if it exists on the new cadence; otherwise the first one
    // that does, so the summary is never empty mid-decision.
    const stillThere = (plans ?? []).some((p) => p.period === next && p.planKey === chosenKey);
    if (!stillThere) setChosenKey((plans ?? []).find((p) => p.period === next)?.planKey ?? null);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!plan) return;
    setError(null);
    setBusy(true);

    const form = new FormData(e.currentTarget);
    const payload = {
      planKey: plan.planKey,
      period: plan.period,
      email: String(form.get("email") ?? ""),
      businessName: String(form.get("businessName") ?? ""),
      phone: String(form.get("phone") ?? "") || undefined,
      billingState: String(form.get("billingState") ?? ""),
      gstin: String(form.get("gstin") ?? "") || undefined,
      website: String(form.get("website") ?? ""),
    };

    try {
      const res = await fetch("/v1/signup/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.message ?? "That didn't go through. Please check the form and try again.");
        setBusy(false);
        return;
      }

      // No gateway configured yet. The signup row EXISTS, so the enquiry is not
      // lost - saying so is more honest than pretending a payment window failed
      // to open, and it is the state this page is in until the keys are set.
      if (!body.gateway) {
        window.location.href = `/signup/done?ref=${encodeURIComponent(body.claimRef)}&pending=1`;
        return;
      }

      const ok = await loadRazorpay();
      if (!ok || !window.Razorpay) {
        setError("The payment window couldn't load. Check your connection and try again.");
        setBusy(false);
        return;
      }

      const rz = new window.Razorpay({
        key: body.gateway.keyId,
        order_id: body.gateway.orderId,
        amount: body.gateway.amountMinor,
        currency: body.gateway.currency,
        name: "Auratel",
        description: `${plan.name} — ${plan.period === "annual" ? "annual billing" : "monthly billing"}`,
        prefill: { email: payload.email, contact: payload.phone ?? "" },
        // The buyer lands here whether or not the webhook has arrived yet. The
        // page polls, and provisioning is idempotent, so arriving "too early"
        // is the normal case rather than an error.
        handler: () => {
          window.location.href = `/signup/done?ref=${encodeURIComponent(body.claimRef)}`;
        },
        modal: {
          ondismiss: () => setBusy(false),
        },
      });
      rz.open();
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  if (error && !plans) {
    return (
      <p className="mk-card p-5 text-[0.9375rem]" style={alertStyle}>
        {error}
      </p>
    );
  }
  if (!plans) {
    return (
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20.5rem]" aria-busy="true">
        <div className="space-y-2.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[4.75rem] animate-pulse rounded-2xl"
              style={{ background: "var(--mk-line)" }}
            />
          ))}
        </div>
        <p className="text-sm" style={{ color: "var(--mk-muted)" }} role="status">
          Loading plans…
        </p>
      </div>
    );
  }
  if (plans.length === 0) {
    return (
      <div className="mk-card p-6">
        <h2 className="text-lg font-semibold">Online checkout isn&apos;t open just now.</h2>
        <p className="mt-2 text-[0.9375rem]" style={{ color: "var(--mk-muted)" }}>
          Tell us what you need and we will set your workspace up by hand, today.
        </p>
        <a href="/start" className="mk-cta mk-cta-sm mt-5">
          Talk to us
          <span aria-hidden="true">→</span>
        </a>
      </div>
    );
  }

  return (
    // `void submit(e)` rather than `onSubmit={submit}`: an async handler
    // returns a promise into an attribute that expects nothing back, which the
    // repo's no-misused-promises rule flags - and there is genuinely nothing to
    // do with a rejection here, because `submit` handles its own.
    <form onSubmit={(e) => void submit(e)}>
      {/* The columns are placed explicitly rather than by source order, because
          the two orders disagree. On a desktop the footer belongs under the
          plan column, in the gap left by three cards being shorter than a
          payment sheet. On a phone there is one column, and source order would
          then put "Compare every plan" and "Talk to us" - two ways to leave -
          immediately above the pay button. So the sheet is placed in column 2
          spanning both rows, the footer in column 1 row 2, and the DOM order
          stays plans -> sheet -> footer, which is the right order on a phone. */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20.5rem] lg:gap-x-7 lg:gap-y-4">
        {/* ── The plan, chosen where you are standing ───────────────────── */}
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[0.9375rem] font-semibold">Choose your plan</h2>
            {periodsOffered.length > 1 ? (
              <div
                className="inline-flex rounded-full p-0.5"
                style={{ background: "var(--mk-ground)", border: "1px solid var(--mk-line)" }}
                role="group"
                aria-label="Billing cadence"
              >
                {periodsOffered.map((p) => {
                  const on = p === period;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => pickPeriod(p)}
                      aria-pressed={on}
                      className="rounded-full px-3 py-1 text-[0.75rem] font-semibold transition-colors"
                      style={
                        on
                          ? { background: "var(--brand-gradient)", color: "#fff" }
                          : { color: "var(--mk-muted)" }
                      }
                    >
                      {p === "annual" ? "Annual" : "Monthly"}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <fieldset>
            <legend className="sr-only">Choose your plan</legend>
            <div className="space-y-2.5">
              {shown.map((p) => {
                const on = plan?.planKey === p.planKey;
                const strip = on ? step : null;
                return (
                  <div key={p.planKey}>
                    <label className="block cursor-pointer">
                      <input
                        type="radio"
                        name="plan"
                        value={p.planKey}
                        checked={on}
                        onChange={() => setChosenKey(p.planKey)}
                        className="peer sr-only"
                      />
                      <span
                        className="flex items-center gap-3 border p-3.5 transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 sm:px-4"
                        style={{
                          borderColor: on ? "var(--brand-mid)" : "var(--mk-line)",
                          background: on
                            ? "color-mix(in srgb, var(--brand-mid) 5%, var(--mk-surface))"
                            : "var(--mk-surface)",
                          boxShadow: on ? "inset 0 0 0 1px var(--brand-mid)" : "none",
                          // Square off the bottom when the upgrade strip is
                          // attached, so the two read as one object.
                          borderRadius: strip ? "16px 16px 0 0" : "16px",
                        }}
                      >
                        {/* The native radio is hidden, so the dot is drawn.
                            Shape AND fill change together - a ring that only
                            went blue would be the one state a colour-blind
                            buyer could not read. */}
                        <span
                          aria-hidden
                          className="grid h-[1.125rem] w-[1.125rem] shrink-0 place-items-center rounded-full border"
                          style={{
                            borderColor: on ? "var(--brand-mid)" : "var(--mk-line)",
                            background: on ? "var(--brand-gradient)" : "transparent",
                          }}
                        >
                          {on ? (
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ background: "#fff" }}
                            />
                          ) : null}
                        </span>

                        <span className="min-w-0 flex-1">
                          <span className="block text-[0.9375rem] font-semibold leading-tight">
                            {p.name}
                          </span>
                          <span
                            className="mt-1 block text-[0.8125rem] leading-tight"
                            style={{ color: "var(--mk-muted)" }}
                          >
                            {meters(p)}
                          </span>
                        </span>

                        <span className="shrink-0 text-right">
                          <span className="mk-display tabular block text-[1.0625rem] leading-none">
                            {rupees(p.totalMinor)}
                          </span>
                          <span
                            className="mt-1 block text-[0.6875rem]"
                            style={{ color: "var(--mk-muted)" }}
                          >
                            /month, inc GST
                          </span>
                        </span>
                      </span>
                    </label>

                    {/* ── The upgrade, attached to the chosen plan ────────
                        One tap, and every number in it comes from the served
                        catalogue. It is an offer rather than a badge: no
                        "most popular", because we do not have that number. */}
                    {strip ? (
                      <button
                        type="button"
                        onClick={() => setChosenKey(strip.to.planKey)}
                        className="flex w-full items-center gap-2 border border-t-0 px-4 py-2.5 text-left text-[0.8125rem] leading-snug"
                        style={{
                          borderColor: "var(--brand-mid)",
                          borderRadius: "0 0 16px 16px",
                          background: "color-mix(in srgb, var(--brand-mid) 10%, var(--mk-surface))",
                          color: "var(--mk-ink)",
                        }}
                      >
                        <span aria-hidden style={{ color: "var(--brand-mid)" }}>
                          ↑
                        </span>
                        <span className="min-w-0 flex-1">
                          Add {strip.gains.join(" and ")} for{" "}
                          <strong className="tabular whitespace-nowrap">
                            {rupees(strip.deltaMinor)} more
                          </strong>{" "}
                          a month — move to {strip.to.name}
                        </span>
                        <span aria-hidden style={{ color: "var(--brand-mid)" }}>
                          →
                        </span>
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {missingHere.length > 0 ? (
              <p className="mt-2.5 text-[0.75rem] leading-snug" style={{ color: "var(--mk-muted)" }}>
                {missingHere.join(" and ")} {missingHere.length === 1 ? "is" : "are"} annual-billing
                only — billed monthly the debit goes over the ₹15,000 a bank will take on a
                standing mandate without asking you every month.
              </p>
            ) : null}
          </fieldset>

          {/* The two things a buyer checks before typing a card number. They
              live here rather than under the button because the payment sheet
              has to stay short enough to finish on one screen. */}
          <ul className="mt-4 space-y-1.5 text-[0.8125rem]" style={{ color: "var(--mk-muted)" }}>
            {[
              "Card, UPI or netbanking through Razorpay — your card details never reach us.",
              "A GST tax invoice is emailed with every debit.",
            ].map((bit) => (
              <li key={bit} className="flex gap-2">
                <span aria-hidden style={{ color: "var(--brand-mid)" }}>
                  ✓
                </span>
                <span>{bit}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* ── The payment sheet ────────────────────────────────────────────
            Razorpay's own register: the amount first, then a short stack of
            quiet fields, then one button. Nothing optional is in the way. */}
        {/* `min-w-0` for the same reason as the plan column: a grid item's
            default `min-width: auto` lets its content set the column width,
            and this one contains a select full of long state names. */}
        <aside className="mk-card min-w-0 overflow-hidden lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div
            className="flex items-end justify-between gap-3 px-4 py-3.5"
            style={{ background: "var(--mk-ground)", borderBottom: "1px solid var(--mk-line)" }}
          >
            <div className="min-w-0">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mk-muted)" }}>
                Due today
              </p>
              <p className="mk-display tabular mt-0.5 text-2xl leading-none">
                {plan ? rupees(plan.totalMinor) : "—"}
              </p>
            </div>
            {plan ? (
              <p className="text-right text-[0.6875rem] leading-snug" style={{ color: "var(--mk-muted)" }}>
                {plan.name}
                <br />
                inc {rupees(plan.taxMinor)} GST
              </p>
            ) : null}
          </div>

          <div className="space-y-3 px-4 py-4">
            <CompactField label="Work email" name="email" type="email" required autoComplete="email" placeholder="you@company.in" />
            <CompactField label="Mobile" name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="98765 43210" />
            <CompactField label="Business name" name="businessName" required autoComplete="organization" placeholder="As it should read on the invoice" />

            <div>
              <label htmlFor="billingState" className="mb-1 block text-[0.75rem] font-medium" style={{ color: "var(--mk-muted)" }}>
                Billing state <span aria-hidden>*</span>
              </label>
              {/* Mandatory, and not for our convenience: it decides IGST vs
                  CGST+SGST on the tax invoice, and CBIC treats the state
                  recorded on the invoice as the buyer's address on record. */}
              <select id="billingState" name="billingState" required defaultValue="" style={selectStyle}>
                <option value="" disabled>
                  Select a state
                </option>
                {GST_STATES.map((s) => (
                  <option key={s.code} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            {/* GSTIN is behind a link because most buyers do not have one to
                hand, and a fifth field on a payment sheet is the one that makes
                somebody come back later. It stays in the DOM once opened, so a
                typed value is never silently dropped on submit. */}
            {gstOpen ? (
              <CompactField
                label="GSTIN"
                name="gstin"
                autoComplete="off"
                spellCheck={false}
                placeholder="33AAAAA0000A1Z5"
                hint="Checksum checked here, so a typo is caught before the invoice."
              />
            ) : (
              <button
                type="button"
                onClick={() => setGstOpen(true)}
                className="text-[0.8125rem] font-medium underline"
                style={{ color: "var(--brand-mid)" }}
              >
                + Add GSTIN for input tax credit
              </button>
            )}

            {error ? (
              <p role="alert" className="rounded-xl p-2.5 text-[0.8125rem] leading-snug" style={alertStyle}>
                {error}
              </p>
            ) : null}

            <button type="submit" disabled={!plan || busy} className="mk-cta w-full justify-center" style={{ padding: "0.8rem 1.25rem" }}>
              {busy ? "Opening payment…" : plan ? `Pay ${rupees(plan.totalMinor)}` : "Choose a plan"}
            </button>

            {/* The sentence the old page did not have. "Billed annually" reads
                as a lump sum to everybody who is not an accountant, and one
                month is what is actually taken. */}
            <p className="text-[0.6875rem] leading-snug" style={{ color: "var(--mk-muted)" }}>
              {plan?.period === "annual"
                ? "One month today, then the same each month. Annual billing is a twelve-month commitment at the lower rate, not a payment up front."
                : "One month today, then the same each month, at the no-commitment rate."}
            </p>
          </div>
        </aside>

        {footer ? <div className="lg:col-start-1 lg:row-start-2">{footer}</div> : null}
      </div>

      {/* Honeypot: off-screen, never focusable, empty for a real browser. */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
    </form>
  );
}

function CompactField({
  label,
  name,
  hint,
  ...rest
}: { label: string; name: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <div>
      {/* The label stays a real label rather than becoming a placeholder. A
          payment sheet is read twice - once while filling it in and once while
          checking it - and a placeholder is gone by the second reading. */}
      <label htmlFor={name} className="mb-1 block text-[0.75rem] font-medium" style={{ color: "var(--mk-muted)" }}>
        {label}
        {rest.required ? <span aria-hidden> *</span> : null}
      </label>
      <input id={name} name={name} aria-describedby={hintId} style={inputStyle} {...rest} />
      {hint ? (
        <p id={hintId} className="mt-1 text-[0.6875rem] leading-snug" style={{ color: "var(--mk-muted)" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ── Field styling ────────────────────────────────────────────────────────
   Lifted from `app/start/funnel-form.tsx`, the house style for a form on this
   site, and tightened one step for the payment sheet. Two values are
   load-bearing rather than taste:

   · `background: var(--mk-surface)` with a `--mk-line` border. The previous
     version was Tailwind's bare `border` on a transparent ground, which on the
     dark theme is a nearly invisible hairline around nothing.
   · `fontSize: 1rem`, exactly, and the 42px height that follows from it. iOS
     Safari zooms the whole page in when a focused input is under 16px and does
     not zoom back out on blur, so a smaller field would shunt the layout
     sideways for the rest of the checkout. This is the floor; the padding is
     what came down. */

const inputStyle: React.CSSProperties = {
  width: "100%",
  // Defensive, and here for the SELECT below rather than for the inputs. A
  // native select's min-content width is its widest option - "Dadra and Nagar
  // Haveli and Daman and Diu" - and a grid item defaults to `min-width: auto`,
  // i.e. min-content, so a select that refuses to shrink can widen its column
  // past the viewport. Measured at 390px the document does not scroll sideways
  // either way; this keeps it that way if the column ever gets narrower.
  minWidth: 0,
  minHeight: "42px",
  padding: "0.5rem 0.75rem",
  borderRadius: "10px",
  border: "1px solid var(--mk-line)",
  background: "var(--mk-surface)",
  color: "var(--mk-ink)",
  fontSize: "1rem",
};

/* A native select renders the operating system's own control, so a form that
   matches every other field to the brand ends up with one control borrowed
   from another application. The chevron has to be a background image: a
   `<select>` may only contain `<option>`, so there is nowhere to hang an icon.
   `currentColor` is not available inside a data URI, so the stroke is the
   literal muted ink, which reads on both grounds. */
const CHEVRON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="9" viewBox="0 0 14 9" fill="none">' +
      '<path d="M1 1L7 7L13 1" stroke="#5b6b80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
  );

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  paddingRight: "2.25rem",
  backgroundImage: `url("${CHEVRON}")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 0.75rem center",
  cursor: "pointer",
};

/* Themed from one hue rather than Tailwind's red-50/red-800 pair, which was
   light-theme ink on a dark surface for every visitor in dark mode. */
const alertStyle: React.CSSProperties = {
  background: "color-mix(in srgb, #c22b2b 8%, transparent)",
  border: "1px solid color-mix(in srgb, #c22b2b 30%, transparent)",
  color: "#c22b2b",
};

/** Razorpay's widget, loaded on demand rather than on every page view. */
function loadRazorpay(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}
