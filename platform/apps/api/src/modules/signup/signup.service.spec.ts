import { SignupService } from "./signup.service";
import { CAPTURE_PLANS, CAPTURE_PLAN_ORDER, mandateCapHeadroom } from "@aura/shared";

/**
 * WHAT A STRANGER IS ALLOWED TO BUY.
 *
 * `isSelfServe` is the only thing standing between the public checkout and a
 * plan that cannot renew without interrupting the customer. It is a pure
 * function over the price list, so it is cheap to pin - and worth pinning,
 * because every way it can be wrong is a way of selling somebody a product
 * that quietly stops working in a month, with nobody on our side to call.
 */
describe("SignupService.isSelfServe", () => {
  it("admits only plan/cadence pairs whose debit clears the mandate cap", () => {
    for (const key of CAPTURE_PLAN_ORDER) {
      const plan = CAPTURE_PLANS[key];
      for (const period of ["annual", "monthly"] as const) {
        if (!SignupService.isSelfServe(key, period, "IN")) continue;
        // Anything it says yes to must survive a renewal untouched.
        expect([key, period, mandateCapHeadroom(plan, "IN", period) >= 0]).toEqual([
          key,
          period,
          true,
        ]);
      }
    }
  });

  it("refuses a negotiated plan outright", () => {
    expect(SignupService.isSelfServe("capture_enterprise", "annual", "IN")).toBe(false);
    expect(SignupService.isSelfServe("capture_enterprise", "monthly", "IN")).toBe(false);
  });

  it("refuses Growth on the monthly cadence but allows it annually", () => {
    // The 20% monthly uplift puts the debit back over ₹15,000. This is the
    // single rule most likely to be "simplified" later by someone who sees an
    // annual-only plan and assumes it is an oversight.
    expect(SignupService.isSelfServe("capture_growth", "annual", "IN")).toBe(true);
    expect(SignupService.isSelfServe("capture_growth", "monthly", "IN")).toBe(false);
  });

  it("refuses a region the plan is not sellable in", () => {
    // Every AE price is marked unsellable, so no cadence of any plan may be
    // bought there - regardless of what the debit would come to.
    for (const key of CAPTURE_PLAN_ORDER) {
      for (const period of ["annual", "monthly"] as const) {
        expect([key, period, SignupService.isSelfServe(key, period, "AE")]).toEqual([
          key,
          period,
          false,
        ]);
      }
    }
  });

  it("refuses a plan key that is not in the catalogue", () => {
    expect(SignupService.isSelfServe("not_a_plan" as never, "annual", "IN")).toBe(false);
  });

  it("offers at least one buyable plan, or the checkout is decorative", () => {
    const buyable = CAPTURE_PLAN_ORDER.flatMap((key) =>
      (["annual", "monthly"] as const)
        .filter((p) => SignupService.isSelfServe(key, p, "IN"))
        .map((p) => `${key}/${p}`),
    );
    expect(buyable.length).toBeGreaterThan(0);
  });
});

describe("SignupService.newClaimRef", () => {
  it("is long, url-safe and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const ref = SignupService.newClaimRef();
      expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes base64url. Short enough to sit in a URL, long enough that it
      // is not worth guessing - though it is deliberately not a credential.
      expect(ref.length).toBeGreaterThanOrEqual(42);
      expect(seen.has(ref)).toBe(false);
      seen.add(ref);
    }
  });
});

describe("the quote a checkout freezes", () => {
  it("charges tax on top and reports a chargeable total", () => {
    const q = SignupService.quote("capture_growth", "IN", "annual");
    expect(q.currency).toBe("INR");
    expect(q.chargeable).toBe(true);
    expect(q.taxMinor).toBeGreaterThan(0);
    expect(q.totalMinor).toBe(q.subtotalMinor + q.taxMinor);
    // The number the bank is asked to move, which is the one that matters.
    expect(q.totalMinor).toBeLessThanOrEqual(1_500_000);
  });

  it("marks a negotiated plan unchargeable rather than quoting a price for it", () => {
    const q = SignupService.quote("capture_enterprise", "IN", "annual");
    expect(q.chargeable).toBe(false);
    expect(q.blockedReason).toBe("negotiated_plan");
  });
});
