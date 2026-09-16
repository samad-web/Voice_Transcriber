import { z } from "zod";
import { featureEnabled, type OrgFeature } from "./org-features";
import type { ReadinessLine } from "./setup-readiness";
import { OWNER_ROLE_ADMINS, type OwnerRole } from "./roles";

/**
 * The new-client setup checklist (migration 0095).
 *
 * ── WHY A CHECKLIST AND NOT A WIZARD ──────────────────────────────────────
 *
 * A wizard owns the session: it decides the order, blocks the console behind
 * itself, and has to be finished in one sitting. That is the wrong shape here
 * because half these steps are not things a person can do at a desk in five
 * minutes - enrolling a handset means having the phone, connecting WhatsApp
 * means a number that is not already on another platform, and adding a
 * telecaller means knowing who they are.
 *
 * So the console stays open and the checklist follows the client around: a
 * banner that persists until the required steps are done, and a modal that
 * opens on first arrival and whenever they ask for it. Nothing here BLOCKS
 * anything - the client can use whatever already works.
 *
 * ── STEPS ARE GATED BY ENTITLEMENT, NOT HARD-CODED ────────────────────────
 *
 * A step naming a feature disappears entirely for a client who was never
 * provisioned it (migration 0093). Telling somebody to connect Meta Lead Ads
 * when the operator did not sell them Meta Lead Ads is worse than saying
 * nothing: it is a checklist item with no page behind it, and it would keep
 * the banner up forever because the step can never complete.
 *
 * That is also why `setupState` derives the required COUNT from the VISIBLE
 * steps rather than from a constant. A client without invoicing has two
 * required steps, not three, and their banner clears when they have done two.
 *
 * ── EVERY *REQUIRED* STEP MUST BE COMPLETABLE BY THE PERSON SEEING IT ─────
 *
 * The rule that decides what may hold the banner up. A required step whose
 * page cannot finish it is a permanent banner and a support ticket.
 *
 * `handset` is the step that proves the rule. It shipped GUIDED-only in 0095,
 * because pairing needed an enrollment token, tokens were minted from the
 * OPERATOR console, and a required step nobody in the tenant could finish is a
 * banner that never clears. Migration 0096 gave the client `/owner/devices`
 * and gave the owner control over who else may use it - so the step became
 * required, and leads the list.
 *
 * Note what had to happen for that: the capability was built FIRST and the
 * checklist followed. Marking it required while it was still unreachable would
 * have been the failure this rule exists to prevent.
 */

export const SetupStepId = z.enum([
  /** A handset enrolled and recording. Without it the product does nothing. */
  "handset",
  /** At least one telecaller, so calls and leads have somebody to belong to. */
  "team",
  /** The business's logo, which brands the console and its documents. */
  "logo",
  /** The client's own payment gateway, for invoicing their customers. */
  "billing",
  /** WhatsApp connected, so inbound threads reach the inbox. */
  "whatsapp",
  /** A lead source: a web form, an email drop, a telephony hook. */
  "lead_sources",
  /** Facebook / Instagram lead forms. */
  "meta_ads",
]);
export type SetupStepId = z.infer<typeof SetupStepId>;

export interface SetupStepSpec {
  id: SetupStepId;
  /** Imperative and short - it is a heading in the modal. */
  label: string;
  /** One sentence saying what it gets them, not what it is. */
  blurb: string;
  /**
   * Where the client goes to do it - or, for `handset`, where they can see it
   * has happened. A REQUIRED step's href must be a page that can finish it.
   */
  href: string;
  /**
   * Required steps hold the banner up. Optional ones are the guided
   * "what next" half: shown, ticked off, never nagged about.
   */
  required: boolean;
  /**
   * Hidden entirely when the org lacks this feature (migration 0093). Absent
   * means the step is core Aura and always applies.
   */
  feature?: OrgFeature;
  /** Guide grouping, in render order. */
  group: "account" | "connect";
}

/**
 * In the order a new client should actually do them, which is NOT the order
 * they matter to us.
 *
 * The handset is first because nothing in this product produces a single row
 * until a phone is paired - a client who uploads a logo and then finds an
 * empty console has been led through the wrong door.
 *
 * Billing comes last because it is the only step whose absence changes
 * nothing today: the platform's own gateway already collects payment
 * (migration 0060), so this is "settle into your own account" rather than
 * "switch payments on".
 */
export const SETUP_STEPS: SetupStepSpec[] = [
  {
    id: "handset",
    label: "Pair your first handset",
    blurb:
      "Install the app on a phone and scan the pairing code. Its calls are then recorded, transcribed and turned into leads.",
    href: "/owner/devices",
    // REQUIRED as of migration 0096, which gave the client its own pairing
    // page. It was guided-only before that for exactly the reason the header
    // gives: a required step nobody in the tenant could finish would have been
    // a banner that never cleared. Now an owner can pair, and can grant it.
    required: true,
    group: "account",
  },
  {
    id: "team",
    label: "Add your telecallers",
    blurb: "Every call and lead is attributed to a person, so add the people who will be on the phones.",
    href: "/owner/team",
    required: true,
    group: "account",
  },
  {
    id: "logo",
    label: "Upload your logo",
    blurb: "Your logo brands this console and appears on the quotations and invoices your customers receive.",
    href: "/owner/branding",
    required: true,
    group: "account",
  },
  {
    id: "billing",
    label: "Connect your payment account",
    blurb:
      "Add your own Razorpay keys so payments on your invoices settle into your account instead of the platform's.",
    href: "/owner/invoices",
    required: true,
    feature: "invoices",
    group: "account",
  },
  {
    id: "whatsapp",
    label: "Connect WhatsApp",
    blurb: "Bring your WhatsApp Business number in, so customer threads land in the inbox beside their calls.",
    href: "/owner/messaging-setup",
    required: false,
    feature: "messaging_setup",
    group: "connect",
  },
  {
    id: "lead_sources",
    label: "Connect a lead source",
    blurb: "Point your website form, enquiry inbox or phone system at Aura so new enquiries arrive as leads.",
    href: "/owner/lead-sources",
    required: false,
    feature: "lead_sources",
    group: "connect",
  },
  {
    id: "meta_ads",
    label: "Connect Facebook lead ads",
    blurb: "Link your Facebook Page so Instant Form submissions become leads the moment somebody taps submit.",
    href: "/owner/meta-ads",
    required: false,
    feature: "meta_ads",
    group: "connect",
  },
];

const BY_ID = new Map(SETUP_STEPS.map((step) => [step.id, step]));

export function setupStep(id: SetupStepId): SetupStepSpec | undefined {
  return BY_ID.get(id);
}

/** One tenant's provisioning, as the checklist needs to see it. */
export interface SetupEntitlement {
  modules: readonly string[];
  features: readonly string[];
}

/**
 * The steps this particular client should see.
 *
 * A step with no `feature` is core Aura and always shows. One that names a
 * feature shows only when the operator provisioned it - see the header for why
 * that is not merely cosmetic.
 */
export function setupStepsFor(entitlement: SetupEntitlement): SetupStepSpec[] {
  return SETUP_STEPS.filter(
    (step) => !step.feature || featureEnabled(step.feature, entitlement.modules, entitlement.features),
  );
}

/** Which steps are done. Absent means not done - a missing key is never a tick. */
export type SetupProgressMap = Partial<Record<SetupStepId, boolean>>;

export interface SetupStepState extends SetupStepSpec {
  done: boolean;
}

export interface SetupState {
  /**
   * What is ALREADY running, measured (setup-readiness.ts). Rendered above the
   * outstanding steps: a client who has paired a handset and watched it record
   * two calls should be shown the product before the homework.
   *
   * Optional because `setupState()` is pure arithmetic over the catalogue and
   * has no facts to measure - the API attaches these from the same query that
   * answers the checklist, and a caller that does not need them simply omits
   * them.
   */
  readiness?: ReadinessLine[];
  steps: SetupStepState[];
  requiredTotal: number;
  requiredDone: number;
  /** Every required step is ticked. Optional ones never hold this back. */
  complete: boolean;
  /**
   * Where "Complete account setup" sends them: the first unfinished REQUIRED
   * step, or the first unfinished optional one once the required set is done.
   * Null when there is genuinely nothing left, which is also when the modal
   * stops having a reason to exist.
   */
  nextHref: string | null;
  nextStepId: SetupStepId | null;
}

/**
 * Fold the catalogue and the completion map into what the console renders.
 *
 * Pure, so the banner's sentence, the modal's list and the API's "is this org
 * done" decision are all the same arithmetic. The alternative - the API
 * deciding `complete` and the console deciding what to display - is how a
 * banner ends up insisting on a step the modal shows as ticked.
 */
export function setupState(entitlement: SetupEntitlement, progress: SetupProgressMap): SetupState {
  const steps = setupStepsFor(entitlement).map((step) => ({
    ...step,
    done: progress[step.id] === true,
  }));

  const required = steps.filter((s) => s.required);
  const requiredDone = required.filter((s) => s.done).length;
  const next = steps.find((s) => s.required && !s.done) ?? steps.find((s) => !s.done) ?? null;

  return {
    steps,
    requiredTotal: required.length,
    requiredDone,
    complete: requiredDone === required.length,
    nextHref: next?.href ?? null,
    nextStepId: next?.id ?? null,
  };
}

/**
 * The banner's second line, built from what is actually left.
 *
 * Generated rather than written, because a fixed sentence goes stale the
 * moment one step is done: "Set up billing and upload a logo" is simply false
 * once the logo is uploaded, and a warning that describes the wrong problem
 * trains people to ignore warnings.
 */
export function setupBannerDetail(state: SetupState): string {
  const outstanding = state.steps.filter((s) => s.required && !s.done).map((s) => shortAction(s.id));
  if (outstanding.length === 0) return "";
  if (outstanding.length === 1) return `${sentenceCase(outstanding[0])} to finish setting up.`;
  const last = outstanding[outstanding.length - 1];
  const rest = outstanding.slice(0, -1).join(", ");
  return `${sentenceCase(rest)} and ${last} to finish setting up.`;
}

/** Lower-case verb phrases, so they compose into one sentence. */
function shortAction(id: SetupStepId): string {
  switch (id) {
    case "handset":
      // Unreachable from the banner (which lists required steps only) and kept
      // exact anyway, so it stays correct if this ever becomes required.
      return "pair a handset";
    case "team":
      return "add a telecaller";
    case "logo":
      return "upload your logo";
    case "billing":
      return "connect a payment account";
    case "whatsapp":
      return "connect WhatsApp";
    case "lead_sources":
      return "connect a lead source";
    case "meta_ads":
      return "connect Facebook lead ads";
  }
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Who is shown the checklist.
 *
 * Owner and manager, the same pair that may act on it. A telecaller cannot
 * upload a logo, enroll a handset or connect a payment account - every route
 * behind these steps refuses them - so showing them a banner about it would be
 * a permanent notice about somebody else's job.
 */
export function seesSetupChecklist(role: OwnerRole): boolean {
  return OWNER_ROLE_ADMINS.includes(role);
}
