/**
 * Which steps each app's connect flow walks (doc 28 §11.1), as plain data.
 *
 * Kept apart from the registry of step COMPONENTS (registry.tsx) so a node
 * test can hold the catalogue and the flow in lock-step without importing a
 * client component - and the registry is typed against this table, so an app
 * listed here with no components is a type error, not a runtime blank.
 *
 * Every flow starts with `review` (what it can touch, what you need) and ends
 * with `done`. In between:
 *
 *   auth    the method itself - a sign-in, a form, a pairing, an address
 *   choose  a pick the provider made necessary: which Pages, which ad account
 *   check   a live look at whether it works, where there is something to look at
 */

export const CONNECT_STEP_KEYS = ["review", "auth", "choose", "check", "done"] as const;
export type ConnectStep = (typeof CONNECT_STEP_KEYS)[number];

export interface ConnectPlan {
  steps: readonly ConnectStep[];
  /** What each step is called in "Step 2 of 4 · …". */
  titles: Partial<Record<ConnectStep, string>>;
}

const DEFAULT_TITLES: Record<ConnectStep, string> = {
  review: "What it can access",
  auth: "Connect",
  choose: "Choose",
  check: "Check it works",
  done: "Connected",
};

const plan = (steps: ConnectStep[], titles: Partial<Record<ConnectStep, string>> = {}): ConnectPlan => ({
  steps,
  titles,
});

export const CONNECT_PLANS = {
  // ── Messaging ───────────────────────────────────────────────────────────
  whatsapp_waba: plan(["review", "auth", "check", "done"], { auth: "Connect the number", check: "Finish and check" }),
  instagram: plan(["review", "auth", "check", "done"], { auth: "Enter the details", check: "Finish in Meta" }),
  facebook_messenger: plan(["review", "auth", "check", "done"], { auth: "Enter the details", check: "Finish in Meta" }),
  whatsapp_personal: plan(["review", "auth", "done"], { auth: "Link your phone" }),

  // ── Lead sources ────────────────────────────────────────────────────────
  meta_lead_ads: plan(["review", "auth", "choose", "done"], { auth: "Sign in to Facebook", choose: "Choose your Pages" }),
  google_sheets: plan(["review", "auth", "done"], { auth: "Choose the sheet" }),
  linkedin_ads: plan(["review", "auth", "choose", "done"], { auth: "Sign in to LinkedIn", choose: "Choose the ad account" }),
  web_forms: plan(["review", "auth", "check", "done"], { auth: "Create your address", check: "Send a test" }),

  // ── Payments ────────────────────────────────────────────────────────────
  razorpay: plan(["review", "auth", "done"], { auth: "Enter your keys" }),

  // ── Telephony ───────────────────────────────────────────────────────────
  superfone: plan(["review", "auth", "check", "done"], { auth: "Get your address", check: "Make a test call" }),
  cti: plan(["review", "auth", "check", "done"], { auth: "Create your address", check: "Make a test call" }),

  // ── Email and calendar ──────────────────────────────────────────────────
  google_workspace: plan(["review", "auth", "check", "done"], { auth: "Sign in to Google", check: "Confirm the account" }),
  microsoft_365: plan(["review", "auth", "check", "done"], { auth: "Sign in to Microsoft", check: "Confirm the account" }),
  smtp: plan(["review", "auth", "done"], { auth: "Enter your mail server" }),
} satisfies Record<string, ConnectPlan>;

export type ConnectableApp = keyof typeof CONNECT_PLANS;

export function connectPlan(appId: string): ConnectPlan | null {
  return (CONNECT_PLANS as Record<string, ConnectPlan>)[appId] ?? null;
}

export function stepTitle(p: ConnectPlan, step: ConnectStep): string {
  return p.titles[step] ?? DEFAULT_TITLES[step];
}

/** A `?step=` value this app's flow actually has, or its first step. */
export function stepFrom(p: ConnectPlan, raw: string | null | undefined): ConnectStep {
  return p.steps.find((s) => s === raw) ?? p.steps[0]!;
}

export function stepAfter(p: ConnectPlan, step: ConnectStep): ConnectStep {
  const i = p.steps.indexOf(step);
  return p.steps[Math.min(i + 1, p.steps.length - 1)]!;
}

export function stepBefore(p: ConnectPlan, step: ConnectStep): ConnectStep | null {
  const i = p.steps.indexOf(step);
  return i > 0 ? p.steps[i - 1]! : null;
}

/** Where the flow remembers the page it was opened from (doc 28 §11.6). Per tab, per tenant. */
export const originKey = (orgId: string, appId: string) => `aura.connect.origin:${orgId}:${appId}`;
