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

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const rupees = (minor: number) =>
  `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export function CheckoutClient() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/v1/signup/plans", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("unavailable"))))
      .then((d) => {
        if (!alive) return;
        setPlans(d.plans ?? []);
        setChosen(d.plans?.[0] ? `${d.plans[0].planKey}:${d.plans[0].period}` : null);
      })
      .catch(() => alive && setError("We couldn't load the plans just now. Please refresh."));
    return () => {
      alive = false;
    };
  }, []);

  const plan = useMemo(
    () => plans?.find((p) => `${p.planKey}:${p.period}` === chosen) ?? null,
    [plans, chosen],
  );

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
    return <p className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm">{error}</p>;
  }
  if (!plans) return <p className="text-sm opacity-70">Loading plans…</p>;
  if (plans.length === 0) {
    return (
      <p className="rounded-xl border p-4 text-sm">
        Online checkout isn&apos;t open just now. <a className="underline" href="/start">Talk to us</a> and
        we&apos;ll set you up.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="mk-eyebrow mb-2">Choose a plan</legend>
        {plans.map((p) => {
          const id = `${p.planKey}:${p.period}`;
          return (
            <label
              key={id}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${
                chosen === id ? "border-[var(--brand-mid)] ring-1 ring-[var(--brand-mid)]" : ""
              }`}
            >
              <input
                type="radio"
                name="plan"
                value={id}
                checked={chosen === id}
                onChange={() => setChosen(id)}
                className="mt-1 min-h-5 min-w-5"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">
                    {p.name}
                    <span className="ml-2 text-sm font-normal opacity-70">
                      {p.period === "annual" ? "billed annually" : "billed monthly"}
                    </span>
                  </span>
                  <span className="font-semibold">{rupees(p.totalMinor)}/mo</span>
                </span>
                <span className="mt-1 block text-sm opacity-75">{p.blurb}</span>
                <span className="mt-1 block text-xs opacity-60">
                  {rupees(p.netMinor)} + {rupees(p.taxMinor)} GST · {p.handsets} handsets
                  {p.transcriptionHours ? ` · ${p.transcriptionHours} hours` : ""}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Work email" name="email" type="email" required autoComplete="email" />
        <Field label="Business name" name="businessName" required autoComplete="organization" />
        <Field label="Mobile" name="phone" type="tel" inputMode="tel" autoComplete="tel" />
        <div>
          <label htmlFor="billingState" className="mb-1 block text-sm font-medium">
            Billing state <span aria-hidden>*</span>
          </label>
          {/* Mandatory, and not for our convenience: it decides IGST vs
              CGST+SGST on the tax invoice, and CBIC treats the state recorded
              on the invoice as the buyer's address on record. */}
          <select
            id="billingState"
            name="billingState"
            required
            className="min-h-11 w-full rounded-lg border px-3"
            defaultValue=""
          >
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
        <Field
          label="GSTIN (optional)"
          name="gstin"
          hint="Add it to claim input tax credit on your invoices."
        />
      </div>

      {/* Honeypot: off-screen, never focusable, empty for a real browser. */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {error ? (
        <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</p>
      ) : null}

      <button type="submit" disabled={busy || !plan} className="mk-cta w-full">
        {busy ? "Opening payment…" : plan ? `Pay ${rupees(plan.totalMinor)} and start` : "Choose a plan"}
      </button>

      <p className="text-xs leading-relaxed opacity-70">
        Prices are per month, including GST at 18%. Your workspace is created as soon as the payment
        clears and the sign-in link goes to the email above — nobody has to set it up for you.
      </p>
    </form>
  );
}

function Field({
  label,
  name,
  hint,
  ...rest
}: { label: string; name: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-medium">
        {label}
        {rest.required ? <span aria-hidden> *</span> : null}
      </label>
      {/* `id` matches `htmlFor`. The funnel shipped without this and three
          labels on its first screen focused nothing. */}
      <input id={name} name={name} className="min-h-11 w-full rounded-lg border px-3" {...rest} />
      {hint ? <p className="mt-1 text-xs opacity-60">{hint}</p> : null}
    </div>
  );
}

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
