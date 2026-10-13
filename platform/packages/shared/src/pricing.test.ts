import { describe, expect, it } from "vitest";
import {
  ADDONS,
  ADDON_KEYS,
  BYTES_PER_GIB,
  CAPTURE_PLANS,
  CAPTURE_PLAN_ORDER,
  LIMIT_BEHAVIOURS,
  MONTHLY_UPLIFT_BP,
  PLAN_FAMILY,
  TAX_REGIMES,
  hoursToMinutes,
  monthlyFromAnnual,
  perHandsetMinor,
  planFamily,
  planPriceMinor,
  quoteAddon,
  quoteSubscription,
  regionSellable,
  taxOn,
  type BillingRegion,
} from "./pricing";
import { EntitlementKey, PLAN_SEED, sweepDays, type QuotaValue, type WindowValue } from "./entitlements";
import { gbToBytes } from "./storage";
import { effectiveLimits, periodKeyUtc, type EffectiveLimitsRow } from "./plan-effective";

/** A rupee figure as the price list prints it, from minor units. */
const major = (minor: number) => minor / 100;

describe("the published price list", () => {
  it("prices every plan in both regions", () => {
    for (const key of CAPTURE_PLAN_ORDER) {
      for (const region of ["IN", "AE"] as BillingRegion[]) {
        const price = CAPTURE_PLANS[key].prices[region];
        expect([key, region, price.annualMonthlyMinor > 0]).toEqual([key, region, true]);
        expect([key, region, price.currency]).toEqual([
          key,
          region,
          region === "IN" ? "INR" : "AED",
        ]);
      }
    }
  });

  it("carries the India figures the price list publishes", () => {
    // Read straight off the document, in major units, so a typo in a paise
    // count is visible as a wrong rupee price rather than hidden in a zero.
    expect(major(CAPTURE_PLANS.record.prices.IN.annualMonthlyMinor)).toBe(999);
    expect(major(CAPTURE_PLANS.capture_starter.prices.IN.annualMonthlyMinor)).toBe(5_999);
    // ₹19,999 for 200 hours - the project owner's decision, 2026-10-12. The
    // alternative was ₹14,999 for 150. Both gave 46% margin at the cap; the
    // price was raised and the hours kept.
    expect(major(CAPTURE_PLANS.capture_growth.prices.IN.annualMonthlyMinor)).toBe(19_999);
    expect(CAPTURE_PLANS.capture_growth.transcriptionHours).toBe(200);
    expect(major(CAPTURE_PLANS.capture_enterprise.prices.IN.annualMonthlyMinor)).toBe(39_999);
  });

  it("carries the UAE figures and marks every one of them unsellable", () => {
    // The prices are sound; the market is gated on law. Recording a call
    // without the counterparty's consent is a criminal offence in the UAE, and
    // an announcement is notice rather than consent - so the AED column is
    // priced, seeded and not for sale until affirmative consent capture ships
    // and counsel has signed off per tenant.
    expect(major(CAPTURE_PLANS.record.prices.AE.annualMonthlyMinor)).toBe(99);
    expect(major(CAPTURE_PLANS.capture_starter.prices.AE.annualMonthlyMinor)).toBe(399);
    expect(major(CAPTURE_PLANS.capture_growth.prices.AE.annualMonthlyMinor)).toBe(899);
    expect(major(CAPTURE_PLANS.capture_enterprise.prices.AE.annualMonthlyMinor)).toBe(2_499);

    for (const key of CAPTURE_PLAN_ORDER) {
      expect([key, CAPTURE_PLANS[key].prices.AE.sellable]).toEqual([key, false]);
      expect([key, CAPTURE_PLANS[key].prices.IN.sellable]).toEqual([key, true]);
    }
    expect(regionSellable("AE")).toBe(false);
    expect(regionSellable("IN")).toBe(true);
  });

  it("marks Enterprise as a floor price in both regions", () => {
    // "from ₹39,999". The number keeps the conversation serious rather than
    // describing what is included, so no checkout is offered against it.
    expect(CAPTURE_PLANS.capture_enterprise.prices.IN.fromPrice).toBe(true);
    expect(CAPTURE_PLANS.capture_enterprise.prices.AE.fromPrice).toBe(true);
    expect(CAPTURE_PLANS.capture_enterprise.negotiated).toBe(true);
    for (const key of ["record", "capture_starter", "capture_growth"] as const) {
      expect([key, CAPTURE_PLANS[key].prices.IN.fromPrice ?? false]).toEqual([key, false]);
    }
  });

  it("never lets a cheaper capture tier cost more or include more", () => {
    for (let i = 1; i < CAPTURE_PLAN_ORDER.length; i += 1) {
      const lower = CAPTURE_PLANS[CAPTURE_PLAN_ORDER[i - 1]];
      const upper = CAPTURE_PLANS[CAPTURE_PLAN_ORDER[i]];
      const label = `${lower.key} -> ${upper.key}`;
      expect([label, upper.prices.IN.annualMonthlyMinor > lower.prices.IN.annualMonthlyMinor]).toEqual([
        label,
        true,
      ]);
      expect([label, upper.handsets >= lower.handsets]).toEqual([label, true]);
      expect([label, upper.audioRetentionDays >= lower.audioRetentionDays]).toEqual([label, true]);
    }
  });

  it("keeps the shared catalogue and the price list in step", () => {
    // Two files describe the same four tiers - `pricing.ts` for money and
    // `entitlements.ts` for limits - and they are read by different code. A
    // Growth that sells 200 hours on the page and meters 150 is the one drift
    // that would reach a customer as a refusal they paid not to have.
    for (const key of CAPTURE_PLAN_ORDER) {
      const plan = CAPTURE_PLANS[key];
      const seed = PLAN_SEED[key];
      expect([key, (seed.paired_handsets as QuotaValue).limit]).toEqual([key, plan.handsets]);
      expect([key, (seed.transcription_hours_monthly as QuotaValue).limit]).toEqual([
        key,
        plan.transcriptionHours,
      ]);
      expect([key, sweepDays(seed.audio_retention_days as WindowValue)]).toEqual([
        key,
        plan.audioRetentionDays,
      ]);
      expect([key, (seed.storage_cap_gb as QuotaValue).limit]).toEqual([key, plan.storageCapGb]);
      expect([key, (seed.speaker_separation as { enabled: boolean }).enabled]).toEqual([
        key,
        plan.speakerSeparation,
      ]);
      expect([key, (seed.ai_features as { enabled: boolean }).enabled]).toEqual([
        key,
        plan.aiAnalysis,
      ]);
    }
  });

  it("files every plan under exactly one family", () => {
    for (const key of CAPTURE_PLAN_ORDER) expect(planFamily(key)).toBe("capture");
    for (const key of ["starter", "growth", "scale", "platform"]) {
      expect(planFamily(key)).toBe("insights");
    }
    expect(planFamily(null)).toBeNull();
    expect(planFamily("not_a_plan")).toBeNull();
    // Every key in the map resolves; a plan with no family would be offered on
    // both rails or neither.
    for (const [key, family] of Object.entries(PLAN_FAMILY)) {
      expect([key, family]).toEqual([key, expect.stringMatching(/^(capture|insights)$/)]);
    }
  });

  it("derives per-handset cost rather than storing it", () => {
    // The price list carries a "per handset" row because it is how a buyer
    // compares us to a per-user product, but nothing bills per handset. It is
    // DERIVED so that raising Growth's headline price cannot leave a stale
    // ₹3,750 sitting under a ₹19,999 plan - which is exactly what a stored
    // column did when the price moved.
    expect(major(perHandsetMinor(CAPTURE_PLANS.capture_growth, "IN"))).toBeCloseTo(4_999.75, 2);
    expect(major(perHandsetMinor(CAPTURE_PLANS.capture_starter, "IN"))).toBeCloseTo(2_999.5, 1);
    expect(major(perHandsetMinor(CAPTURE_PLANS.record, "IN"))).toBeCloseTo(499.5, 1);
  });
});

describe("monthly billing", () => {
  it("costs about 20% more and lands on a whole currency unit", () => {
    expect(MONTHLY_UPLIFT_BP).toBe(2000);
    // The rounding is what makes the uplift a price somebody would print:
    // ₹999 x 1.2 is ₹1,198.80, and nobody puts that on a price list.
    expect(major(monthlyFromAnnual(99_900))).toBe(1_199);
    expect(major(monthlyFromAnnual(599_900))).toBe(7_199);
    expect(major(monthlyFromAnnual(1_999_900))).toBe(23_999);
    expect(major(monthlyFromAnnual(9_900))).toBe(119);
    expect(major(monthlyFromAnnual(89_900))).toBe(1_079);
  });

  it("always yields an integer number of minor units", () => {
    for (const key of CAPTURE_PLAN_ORDER) {
      for (const region of ["IN", "AE"] as BillingRegion[]) {
        const monthly = planPriceMinor(CAPTURE_PLANS[key], region, "monthly");
        expect([key, region, Number.isInteger(monthly)]).toEqual([key, region, true]);
      }
    }
  });

  it("quotes the annual basis unchanged", () => {
    // Every number on the price list IS the annual-billing figure, so the
    // annual quote must be the stored one and not a round-trip through the
    // uplift.
    expect(planPriceMinor(CAPTURE_PLANS.capture_growth, "IN", "annual")).toBe(1_999_900);
  });
});

describe("tax", () => {
  it("adds 18% GST in India and 5% VAT in the UAE", () => {
    expect(TAX_REGIMES.IN).toEqual({ label: "GST", kind: "gst", rateBp: 1800 });
    expect(TAX_REGIMES.AE).toEqual({ label: "VAT", kind: "vat", rateBp: 500 });
    expect(taxOn(1_999_900, "IN")).toBe(359_982);
    expect(taxOn(89_900, "AE")).toBe(4_495);
  });

  it("stays integral on amounts that would not divide evenly", () => {
    // 18% of ₹5,999 is ₹1,079.82, which is 107982 paise exactly - but reached
    // through a float it is 107981.99999999999. This is the whole reason the
    // rate is basis points and the arithmetic is integer.
    expect(taxOn(599_900, "IN")).toBe(107_982);
    for (let minor = 1; minor < 2000; minor += 7) {
      expect(Number.isInteger(taxOn(minor, "IN"))).toBe(true);
      expect(Number.isInteger(taxOn(minor, "AE"))).toBe(true);
    }
  });

  it("taxes the subtotal once, not each line", () => {
    // Taxing each line and summing gives a different answer from taxing the
    // sum, and an invoice whose lines do not add up to its total is a support
    // ticket every time.
    const quote = quoteSubscription({
      planKey: "capture_growth",
      region: "IN",
      period: "annual",
      addons: { extra_handset: 3, extra_storage_5gb: 1 },
    });
    const lineSum = quote.lines.reduce((sum, line) => sum + line.amountMinor, 0);
    expect(quote.subtotalMinor).toBe(lineSum);
    expect(quote.taxMinor).toBe(taxOn(lineSum, "IN"));
    expect(quote.totalMinor).toBe(quote.subtotalMinor + quote.taxMinor);
  });
});

describe("quoteSubscription", () => {
  it("prices Growth in India with GST on top", () => {
    const quote = quoteSubscription({ planKey: "capture_growth", region: "IN", period: "annual" });
    expect(quote.currency).toBe("INR");
    expect(major(quote.subtotalMinor)).toBe(19_999);
    expect(major(quote.taxMinor)).toBeCloseTo(3_599.82, 2);
    expect(major(quote.totalMinor)).toBeCloseTo(23_598.82, 2);
    expect(quote.chargeable).toBe(true);
    expect(quote.blockedReason).toBeNull();
  });

  it("adds recurring add-ons as their own lines, capped at maxUnits", () => {
    const quote = quoteSubscription({
      planKey: "capture_starter",
      region: "IN",
      period: "annual",
      addons: { extra_handset: 2 },
    });
    const line = quote.lines.find((l) => l.key === "extra_handset");
    expect(line?.units).toBe(2);
    expect(line?.amountMinor).toBe(2 * ADDONS.extra_handset.priceMinor.IN);

    const silly = quoteSubscription({
      planKey: "capture_starter",
      region: "IN",
      period: "annual",
      addons: { extra_handset: 9_999 },
    });
    expect(silly.lines.find((l) => l.key === "extra_handset")?.units).toBe(
      ADDONS.extra_handset.maxUnits,
    );
  });

  it("leaves hour packs out of a subscription quote", () => {
    // A pack is a one-off purchase for one period, not part of a recurring
    // price. Quoting it alongside the plan would bill it every month.
    const quote = quoteSubscription({
      planKey: "capture_growth",
      region: "IN",
      period: "annual",
      addons: { topup_hours_25: 2 },
    });
    expect(quote.lines.map((l) => l.key)).toEqual(["capture_growth"]);
  });

  it("refuses to charge in an unsellable region, while still pricing it", () => {
    const quote = quoteSubscription({ planKey: "capture_growth", region: "AE", period: "annual" });
    // The amounts are real - a buyer should see them - and the flag is what
    // turns the button into "Talk to us".
    expect(major(quote.subtotalMinor)).toBe(899);
    expect(quote.taxLabel).toBe("VAT");
    expect(quote.chargeable).toBe(false);
    expect(quote.blockedReason).toBe("region_not_sellable");
  });

  it("refuses to charge for a negotiated tier", () => {
    const quote = quoteSubscription({
      planKey: "capture_enterprise",
      region: "IN",
      period: "annual",
    });
    expect(quote.chargeable).toBe(false);
    expect(quote.blockedReason).toBe("negotiated_plan");
  });

  it("orders its lines deterministically", () => {
    // So two quotes for the same request are byte-identical and an
    // idempotency key computed over them matches.
    const args = {
      planKey: "capture_growth" as const,
      region: "IN" as BillingRegion,
      period: "annual" as const,
      addons: { extra_storage_5gb: 1, extra_handset: 1, extra_retention_30d: 1 },
    };
    expect(JSON.stringify(quoteSubscription(args))).toBe(JSON.stringify(quoteSubscription(args)));
    expect(quoteSubscription(args).lines.map((l) => l.key)).toEqual([
      "capture_growth",
      "extra_handset",
      "extra_storage_5gb",
      "extra_retention_30d",
    ]);
  });
});

describe("the add-on catalogue", () => {
  it("prices a top-up above the in-plan rate, so upgrading is cheaper", () => {
    // The ordering IS the design. A customer who tops up every month is
    // paying a premium for the privilege and can see that moving up a tier
    // costs less - the hour packs work out at ₹80 and ₹70 against an
    // effective in-plan rate of ₹60 on Starter.
    const starterRate =
      CAPTURE_PLANS.capture_starter.prices.IN.annualMonthlyMinor /
      (CAPTURE_PLANS.capture_starter.transcriptionHours ?? 1);
    const pack25 = ADDONS.topup_hours_25.priceMinor.IN / ADDONS.topup_hours_25.grant;
    const pack100 = ADDONS.topup_hours_100.priceMinor.IN / ADDONS.topup_hours_100.grant;
    expect(major(starterRate)).toBeCloseTo(59.99, 2);
    expect(major(pack25)).toBeCloseTo(79.96, 2);
    expect(major(pack100)).toBeCloseTo(69.99, 2);
    expect(pack25).toBeGreaterThan(starterRate);
    expect(pack100).toBeGreaterThan(starterRate);
    // And the bigger pack is the better deal, or nobody would buy it.
    expect(pack100).toBeLessThan(pack25);
  });

  it("names an entitlement that exists for every add-on", () => {
    // An add-on pointing at a key the catalogue does not have raises nothing,
    // silently - the customer pays and the ceiling does not move.
    for (const key of ADDON_KEYS) {
      const spec = ADDONS[key];
      expect([key, EntitlementKey.options.includes(spec.entitlement)]).toEqual([key, true]);
    }
  });

  it("carries the published India and UAE prices", () => {
    expect(major(ADDONS.topup_hours_25.priceMinor.IN)).toBe(1_999);
    expect(major(ADDONS.topup_hours_100.priceMinor.IN)).toBe(6_999);
    expect(major(ADDONS.extra_handset.priceMinor.IN)).toBe(1_499);
    expect(major(ADDONS.extra_storage_5gb.priceMinor.IN)).toBe(499);
    expect(major(ADDONS.extra_retention_30d.priceMinor.IN)).toBe(799);
    expect(major(ADDONS.topup_hours_25.priceMinor.AE)).toBe(89);
    expect(major(ADDONS.extra_handset.priceMinor.AE)).toBe(99);
  });

  it("quotes a pack with tax and refuses an unsellable region", () => {
    const quote = quoteAddon("topup_hours_25", 2, "IN");
    expect(quote.subtotalMinor).toBe(2 * 199_900);
    expect(quote.taxMinor).toBe(taxOn(2 * 199_900, "IN"));
    expect(quote.chargeable).toBe(true);

    const uae = quoteAddon("topup_hours_25", 1, "AE");
    expect(uae.chargeable).toBe(false);
    expect(uae.blockedReason).toBe("region_not_sellable");
  });

  it("never quotes fewer than one unit or more than the cap", () => {
    expect(quoteAddon("extra_handset", 0, "IN").lines[0].units).toBe(1);
    expect(quoteAddon("extra_handset", -5, "IN").lines[0].units).toBe(1);
    expect(quoteAddon("extra_handset", 10_000, "IN").lines[0].units).toBe(
      ADDONS.extra_handset.maxUnits,
    );
  });
});

describe("meters", () => {
  it("converts included hours to the minutes the platform actually counts", () => {
    // The price list speaks hours; every meter in the platform counts minutes.
    // One conversion, in one place, is what keeps a 200-hour plan from being
    // enforced as a 200-minute one.
    expect(hoursToMinutes(200)).toBe(12_000);
    expect(hoursToMinutes(0)).toBe(0);
    expect(hoursToMinutes(null)).toBeNull();
  });

  it("agrees with the storage module about what a gigabyte is", () => {
    // Two factors - 1000 in one place and 1024 in another - are exactly how an
    // owner's quota stops adding up between the plan page and the storage bar.
    expect(BYTES_PER_GIB).toBe(1024 ** 3);
    expect(gbToBytes(5)).toBe(5 * BYTES_PER_GIB);
  });

  it("names a behaviour for all four published limits, and refuses only one", () => {
    expect(LIMIT_BEHAVIOURS.map((b) => b.entitlement)).toEqual([
      "paired_handsets",
      "transcription_hours_monthly",
      "audio_retention_days",
      "storage_cap_gb",
    ]);
    // A call is never refused. The handset cap is the only hard stop, and it
    // stops an administrative action rather than a recording.
    expect(LIMIT_BEHAVIOURS.filter((b) => b.action === "refuse").map((b) => b.entitlement)).toEqual([
      "paired_handsets",
    ]);
    // And the two that warn are the two with a monthly meter behind them.
    expect(LIMIT_BEHAVIOURS.filter((b) => b.warns).map((b) => b.entitlement)).toEqual([
      "transcription_hours_monthly",
      "storage_cap_gb",
    ]);
  });
});

// ── Effective limits: the plan plus what was bought on top ───────────────────

function row(over: Partial<EffectiveLimitsRow> = {}): EffectiveLimitsRow {
  return {
    plan_key: "capture_growth",
    plan_family: "capture",
    plan_name: "Growth",
    billing_region: "IN",
    entitlements: PLAN_SEED.capture_growth as unknown as Record<string, unknown>,
    addon_units: null,
    grant_amounts: null,
    consent_cleared: false,
    asr_monthly_minutes_budget: null,
    transcription_enabled: true,
    ...over,
  };
}

describe("effectiveLimits", () => {
  it("reads a plan's four meters", () => {
    const limits = effectiveLimits(row());
    expect(limits.handsets).toBe(4);
    expect(limits.transcriptionHours).toBe(200);
    expect(limits.transcriptionMinutes).toBe(12_000);
    expect(limits.audioRetentionDays).toBe(90);
    expect(limits.storageCapBytes).toBe(15 * BYTES_PER_GIB);
    expect(limits.speakerSeparation).toBe(true);
    expect(limits.transcriptionAllowed).toBe(true);
  });

  it("gives a tenant with no plan no limits at all", () => {
    // What every tenant that predates the plan system has, and what 0197
    // relies on when it creates no subscriptions: they keep exactly the
    // product they have today.
    const limits = effectiveLimits(row({ plan_key: null, plan_family: null, entitlements: null }));
    expect(limits.planKey).toBeNull();
    expect(limits.handsets).toBeNull();
    expect(limits.transcriptionMinutes).toBeNull();
    expect(limits.audioRetentionDays).toBeNull();
    expect(limits.storageCapBytes).toBeNull();
    expect(limits.speakerSeparation).toBe(true);
    expect(limits.transcriptionAllowed).toBe(true);
  });

  it("adds a recurring add-on to the ceiling it raises", () => {
    const limits = effectiveLimits(
      row({ addon_units: { extra_handset: 2, extra_storage_5gb: 3, extra_retention_30d: 1 } }),
    );
    expect(limits.handsets).toBe(6);
    expect(limits.storageCapBytes).toBe(30 * BYTES_PER_GIB);
    expect(limits.audioRetentionDays).toBe(120);
  });

  it("leaves an unlimited ceiling unlimited when an add-on is held", () => {
    // `null + 5` is 5 in JavaScript, which would turn "no ceiling" into "a
    // ceiling of five" and refuse almost everything. This is the arithmetic
    // bug `addToCeiling` exists to make impossible.
    const limits = effectiveLimits(
      row({
        plan_key: "capture_enterprise",
        plan_name: "Enterprise",
        entitlements: PLAN_SEED.capture_enterprise as unknown as Record<string, unknown>,
        addon_units: { extra_storage_5gb: 4 },
      }),
    );
    expect(limits.storageCapBytes).toBeNull();
    expect(limits.transcriptionMinutes).toBeNull();
    expect(limits.handsets).toBe(10);
  });

  it("adds this period's hour packs to the monthly allowance", () => {
    const limits = effectiveLimits(
      row({ grant_amounts: { topup_hours_25: 25, topup_hours_100: 100 } }),
    );
    expect(limits.toppedUpHours).toBe(125);
    expect(limits.transcriptionHours).toBe(325);
    expect(limits.transcriptionMinutes).toBe(19_500);
  });

  it("lets an operator's own ceiling win over the plan's", () => {
    // `asr_monthly_minutes_budget` predates plans and is how an operator caps
    // a tenant by hand - including a negotiated Enterprise hour count. The
    // reverse precedence would make a deliberate cap silently ignored.
    const limits = effectiveLimits(row({ asr_monthly_minutes_budget: 600 }));
    expect(limits.transcriptionMinutes).toBe(600);
    // The plan's own figure is still reported, for the page that shows both.
    expect(limits.transcriptionHours).toBe(200);
  });

  it("lets Record record but never transcribe", () => {
    // Zero hours AND no AI, which together are what make this tier cost
    // nothing per call: the audio is never sent to a provider at all.
    const limits = effectiveLimits(
      row({
        plan_key: "record",
        plan_name: "Record",
        entitlements: PLAN_SEED.record as unknown as Record<string, unknown>,
      }),
    );
    expect(limits.aiAnalysis).toBe(false);
    expect(limits.transcriptionAllowed).toBe(false);
    expect(limits.speakerSeparation).toBe(false);
    expect(limits.audioRetentionDays).toBe(30);
    expect(limits.handsets).toBe(2);
  });

  it("honours an operator switching transcription off on a plan that sells it", () => {
    const limits = effectiveLimits(row({ transcription_enabled: false }));
    expect(limits.aiAnalysis).toBe(true);
    expect(limits.transcriptionAllowed).toBe(false);
  });

  it("stops an AE tenant recording until a counsel opinion is recorded", () => {
    // Recording a call without the counterparty's consent is a criminal
    // offence in the UAE. The database trigger clamps `consent_policy`; this
    // is the same rule read back, so a surface can SAY why rather than only
    // observing that nothing records.
    const blocked = effectiveLimits(row({ billing_region: "AE", consent_cleared: false }));
    expect(blocked.region).toBe("AE");
    expect(blocked.recordingProhibited).toBe(true);
    expect(blocked.transcriptionAllowed).toBe(false);

    const cleared = effectiveLimits(row({ billing_region: "AE", consent_cleared: true }));
    expect(cleared.recordingProhibited).toBe(false);
    expect(cleared.transcriptionAllowed).toBe(true);
  });

  it("does not let the consent gate touch an Indian tenant", () => {
    expect(effectiveLimits(row({ consent_cleared: false })).recordingProhibited).toBe(false);
  });

  it("prefers a live trial's entitlements, as the query hands them over", () => {
    // The SQL picks the trial plan while `trial_ends_at > now()`, so this
    // function only ever sees one set of values. The assertion is that it uses
    // what it is given rather than re-reading `plan_key`'s own seed - which is
    // what would happen if it looked the plan up by name.
    const limits = effectiveLimits(
      row({
        plan_key: "record",
        plan_name: "Record",
        entitlements: PLAN_SEED.capture_growth as unknown as Record<string, unknown>,
      }),
    );
    expect(limits.planKey).toBe("record");
    expect(limits.handsets).toBe(4);
    expect(limits.transcriptionHours).toBe(200);
  });
});

describe("periodKeyUtc", () => {
  it("buckets by the UTC calendar month, zero-padded", () => {
    // The same bucket `usage_meters.period` uses and the same window the
    // worker's ceiling check reads. A grant written into one month and metered
    // against another is a customer paying for hours they cannot spend.
    expect(periodKeyUtc(new Date("2026-10-13T22:30:00Z"))).toBe("2026-10");
    expect(periodKeyUtc(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(periodKeyUtc(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });

  it("is a UTC bucket and not a local one", () => {
    // 2026-11-01T02:00 in Dubai (+04) is still October in UTC, which is the
    // known divergence the price list accepts: a floor in Dubai sees its
    // allowance reset partway through their evening.
    expect(periodKeyUtc(new Date("2026-10-31T22:00:00Z"))).toBe("2026-10");
  });
});
