import { z } from "zod";
import { enabledFeatures, type FeatureKey, type FeatureOverrides } from "./features";
import type { OrgModule } from "./org-modules";
import type { ReadinessLine } from "./setup-readiness";
import { OWNER_ROLE_ADMINS, OwnerRole, canPairDevices } from "./roles";

/**
 * The new-client setup checklist (migration 0106) and the "Finish your setup -
 * X of N" guide built over it (doc 27 §7, migration 0129).
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
 * ── TWO SURFACES, ONE CATALOGUE ───────────────────────────────────────────
 *
 * The 0106 banner and modal nag about the REQUIRED steps only, and close for
 * good once those are done (`setup_completed_at`). The guide (doc 27) is the
 * sidebar meter and `/owner/get-started`: it covers EVERY step that applies to
 * the tenant, required or not, and closes when all of them are done or skipped
 * (`guide_completed_at`) or when an owner hides it (`guide_dismissed_at`).
 * Both read this one list, so the modal can never tick a step the guide shows
 * as open.
 *
 * ── STEPS ARE GATED BY ENTITLEMENT, NOT HARD-CODED ────────────────────────
 *
 * A step naming a feature or module disappears entirely for a client who was
 * never provisioned it (migrations 0072/0101). Telling somebody to connect Meta
 * Lead Ads when the operator did not sell them Meta Lead Ads is worse than
 * saying nothing: it is a checklist item with no page behind it, and it would
 * keep the guide open forever because the step can never complete. The same
 * goes for a step the DEPLOYMENT cannot offer (`availability`): Meta lead ads
 * with no Meta app configured is a button that leads to an error.
 *
 * That is also why every count is derived from the VISIBLE steps rather than
 * from a constant. "N" in "X of N" is never a number anybody typed.
 *
 * ── EVERY *REQUIRED* STEP MUST BE COMPLETABLE FROM ITS PAGE ───────────────
 *
 * The rule that decides what may hold the banner up. A required step whose
 * page cannot finish it is a permanent banner and a support ticket.
 *
 * `handset` is the step that proves the rule. It shipped GUIDED-only in 0106,
 * because pairing needed an enrollment token, tokens were minted from the
 * OPERATOR console, and a required step nobody in the tenant could finish is a
 * banner that never clears. Migration 0107 gave the client `/owner/devices`
 * and gave the owner control over who else may use it - so the step became
 * required, and leads the list.
 *
 * Doc 27 found the rule broken twice more and fixed both:
 *   - `team` measured `telecallers` only, and its page (Staff) cannot create a
 *     telecaller row - only naming a handset on the dashboard can. Its signal
 *     now also counts a second active member, which Staff CAN create.
 *   - `billing` was required, shown to managers, and owner-only in the API. It
 *     is optional now, and `business_profile` (which the owner can always
 *     finish) takes its required slot.
 *
 * ── THE VIEWER RULE ───────────────────────────────────────────────────────
 *
 * A step the viewer cannot do (`doers`) still shows and still COUNTS - the
 * org's progress is the org's, and a manager's "6 of 24" must be the owner's
 * "6 of 24". It renders "Owner only" instead of a Set up button, and the banner
 * names it as the owner's job rather than theirs.
 */

export const SetupStepId = z.enum([
  // ── account ──
  /** A handset enrolled and recording. Without it the product does nothing. */
  "handset",
  /** Somebody besides the owner, so calls and leads have people to belong to. */
  "team",
  /** The business's logo, which brands the console and its documents. */
  "logo",
  /** Legal name and state - who the business is, for its documents. */
  "business_profile",
  /** A phone for call-access approval codes (0122), when that gate is on. */
  "call_access_phone",
  // ── team ──
  "invite_colleague",
  "roles",
  "commission",
  // ── calls ──
  "transcription",
  "call_sop",
  "agent",
  "projects",
  // ── leads ──
  /** A lead source: a web form, an email drop, a telephony hook. */
  "lead_sources",
  /** Facebook / Instagram lead forms. */
  "meta_ads",
  /** WhatsApp connected, so inbound threads reach the inbox. */
  "whatsapp",
  "mailbox",
  "lead_routing",
  "outreach",
  // ── sell ──
  "pipeline",
  "products",
  "import",
  "quotation",
  "invoice",
  /** The client's own payment gateway, for invoicing their customers. */
  "billing",
  "report",
]);
export type SetupStepId = z.infer<typeof SetupStepId>;

/** Guide grouping. `finance` is empty until doc 26 F1 adds its steps. */
export const SetupGroup = z.enum(["account", "team", "calls", "leads", "sell", "finance"]);
export type SetupGroup = z.infer<typeof SetupGroup>;

export const SETUP_GROUP_LABELS: Record<SetupGroup, string> = {
  account: "Your account",
  team: "Your team",
  calls: "Calls",
  leads: "Leads",
  sell: "Sell",
  finance: "Finance",
};

/**
 * Facts about the deployment or the org that decide whether a step can be
 * offered at all - not entitlement, and not progress.
 *
 *   meta_app          META_APP_SECRET is configured, so Meta lead ads can connect.
 *   call_access_gate  this org has the 0122 call-access gate switched on, so an
 *                     approver's phone number matters.
 */
export const SetupAvailability = z.enum(["meta_app", "call_access_gate"]);
export type SetupAvailability = z.infer<typeof SetupAvailability>;

const ADMINS: OwnerRole[] = ["owner", "manager"];
const ADMINS_AND_MARKETING: OwnerRole[] = ["owner", "manager", "marketing"];
const ADMINS_AND_SALES: OwnerRole[] = ["owner", "manager", "sales"];
const OWNER_ONLY: OwnerRole[] = ["owner"];
const EVERYONE: OwnerRole[] = [...OwnerRole.options];

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
   * Required steps hold the banner up and cannot be skipped. Optional ones are
   * the guided half: shown, ticked off, skippable, never nagged about.
   */
  required: boolean;
  group: SetupGroup;
  /**
   * Who can complete it. Everybody else sees the step, and it counts, but it
   * reads "Owner only" rather than offering a button their persona 403s on.
   */
  doers: OwnerRole[];
  /** Hidden entirely when the org lacks this feature (migration 0101). */
  feature?: FeatureKey;
  /** Hidden entirely when the org lacks this module (migration 0072). */
  module?: OrgModule;
  /** Hidden entirely when this fact does not hold - see SetupAvailability. */
  availability?: SetupAvailability;
}

/**
 * In the order a new client should actually do them, which is NOT the order
 * they matter to us - within each group, and the groups in render order.
 *
 * The handset is first because nothing in this product produces a single row
 * until a phone is paired - a client who uploads a logo and then finds an
 * empty console has been led through the wrong door.
 */
export const SETUP_STEPS: SetupStepSpec[] = [
  // ── Your account ─────────────────────────────────────────────────────────
  {
    id: "handset",
    label: "Pair your first handset",
    blurb:
      "Install the app on a phone and scan the pairing code. Its calls are then recorded, transcribed and turned into leads.",
    href: "/owner/devices",
    // REQUIRED as of migration 0107, which gave the client its own pairing
    // page. It was guided-only before that for exactly the reason the header
    // gives: a required step nobody in the tenant could finish would have been
    // a banner that never cleared. Now an owner can pair, and can grant it.
    required: true,
    group: "account",
    // Plus anybody the owner granted `can_pair_devices` - see canDoSetupStep.
    doers: OWNER_ONLY,
  },
  {
    id: "team",
    label: "Add your telecallers",
    blurb: "Every call and lead is attributed to a person, so add the people who will be on the phones.",
    href: "/owner/staff?tab=team",
    required: true,
    group: "account",
    doers: OWNER_ONLY,
  },
  {
    id: "logo",
    label: "Upload your logo",
    blurb: "Your logo brands this console and appears on the quotations and invoices your customers receive.",
    href: "/owner/branding",
    required: true,
    feature: "branding",
    group: "account",
    doers: ADMINS_AND_MARKETING,
  },
  {
    id: "business_profile",
    label: "Complete your business profile",
    blurb: "Your legal name and address, so documents your customers receive say who they are from.",
    href: "/owner/account/business",
    // Took billing's required slot (doc 26 Q10). Unlike billing, the owner can
    // always finish it: no GSTIN, no gateway, no third party - a name and a state.
    required: true,
    group: "account",
    doers: OWNER_ONLY,
  },
  {
    id: "call_access_phone",
    label: "Add a phone for call-access approvals",
    blurb: "Approval codes for vendor access to your recordings go to this number, so you can say yes from anywhere.",
    href: "/owner/account/profile",
    required: false,
    availability: "call_access_gate",
    group: "account",
    doers: OWNER_ONLY,
  },

  // ── Your team ────────────────────────────────────────────────────────────
  {
    id: "invite_colleague",
    label: "Invite a manager or colleague",
    blurb: "Give someone else a login, so the console isn't one person's job.",
    href: "/owner/staff?tab=team",
    required: false,
    group: "team",
    doers: OWNER_ONLY,
  },
  {
    id: "roles",
    label: "Review who can see what",
    blurb: "Make a role of your own when the standard ones give someone too much, or too little.",
    href: "/owner/staff?tab=roles",
    required: false,
    feature: "staff",
    module: "crm",
    group: "team",
    doers: OWNER_ONLY,
  },
  {
    id: "commission",
    label: "Set up a commission plan",
    blurb: "Tell the reports how your people are paid, so the commission report shows real money.",
    href: "/owner/reports",
    required: false,
    feature: "reports",
    module: "crm",
    group: "team",
    doers: OWNER_ONLY,
  },

  // ── Calls ────────────────────────────────────────────────────────────────
  {
    id: "transcription",
    label: "Tune transcription to your language",
    blurb: "Set the language your calls are in and teach it your product names, so transcripts get them right.",
    href: "/owner/transcription",
    required: false,
    feature: "transcription",
    group: "calls",
    doers: ADMINS,
  },
  {
    id: "call_sop",
    label: "Write a call procedure",
    blurb: "Spell out what a good call covers, and every call is checked against it.",
    href: "/owner/sops",
    required: false,
    feature: "call_sops",
    group: "calls",
    doers: ADMINS,
  },
  {
    id: "agent",
    label: "Build an AI agent",
    blurb: "Decide what the AI pulls out of each call and chat, in your own words.",
    href: "/owner/agents",
    required: false,
    feature: "agent_studio",
    group: "calls",
    doers: ADMINS,
  },
  {
    id: "projects",
    label: "Set up your project catalogue",
    blurb: "List what you sell, and each call and lead is labelled with the project it's about.",
    href: "/owner/projects",
    required: false,
    feature: "projects",
    group: "calls",
    doers: ADMINS,
  },

  // ── Leads ────────────────────────────────────────────────────────────────
  {
    id: "lead_sources",
    label: "Connect a lead source",
    blurb: "Point your website form, enquiry inbox or phone system at Aura so new enquiries arrive as leads.",
    // Into the Integrations store (doc 28 §0.4): every connect flow lives
    // there now, and the lead-source apps are one category of it.
    href: "/owner/integrations?category=leads",
    required: false,
    feature: "lead_sources",
    group: "leads",
    doers: ADMINS_AND_MARKETING,
  },
  {
    id: "meta_ads",
    label: "Connect Facebook lead ads",
    blurb: "Link your Facebook Page so Instant Form submissions become leads the moment somebody taps submit.",
    href: "/owner/integrations/meta_lead_ads/connect",
    required: false,
    feature: "meta_ads",
    availability: "meta_app",
    group: "leads",
    doers: ADMINS_AND_MARKETING,
  },
  {
    id: "whatsapp",
    label: "Connect WhatsApp",
    blurb: "Bring your WhatsApp Business number in, so customer threads land in the inbox beside their calls.",
    href: "/owner/integrations/whatsapp_waba/connect",
    required: false,
    feature: "messaging_setup",
    group: "leads",
    doers: ADMINS_AND_MARKETING,
  },
  {
    id: "mailbox",
    label: "Connect an email inbox",
    blurb: "Emails with your customers appear on their timeline, next to their calls.",
    // The store's "Mine" view: Gmail, Outlook or any mailbox, each person's own.
    href: "/owner/integrations?view=mine",
    required: false,
    feature: "connections",
    group: "leads",
    // Anyone: a mailbox is connected by the person whose mailbox it is.
    doers: EVERYONE,
  },
  {
    id: "lead_routing",
    label: "Route new leads automatically",
    blurb: "New leads go straight to the right person, round-robin or by rule, instead of waiting for someone to hand them out.",
    href: "/owner/lead-routing",
    required: false,
    feature: "lead_routing",
    group: "leads",
    doers: ADMINS,
  },
  {
    id: "outreach",
    label: "Create a follow-up cadence",
    blurb: "A ladder of reminders so no lead is forgotten after the first call.",
    href: "/owner/outreach",
    required: false,
    feature: "outreach",
    group: "leads",
    doers: ADMINS,
  },

  // ── Sell ─────────────────────────────────────────────────────────────────
  {
    id: "pipeline",
    label: "Make the pipeline yours",
    blurb: "Rename the deal stages to the way your business actually sells.",
    href: "/owner/deals",
    required: false,
    feature: "deals",
    group: "sell",
    doers: ADMINS,
  },
  {
    id: "products",
    label: "Add your products or services",
    blurb: "A price list, so quotations and invoices are a few clicks instead of retyping.",
    href: "/owner/products",
    required: false,
    feature: "products",
    group: "sell",
    doers: ADMINS_AND_SALES,
  },
  {
    id: "import",
    label: "Import your existing contacts",
    blurb: "Bring your spreadsheet in, so the CRM starts with the customers you already have.",
    href: "/owner/import",
    required: false,
    feature: "import",
    group: "sell",
    doers: ADMINS,
  },
  {
    id: "quotation",
    label: "Create your first quotation",
    blurb: "Send a customer a branded quote straight from their deal.",
    href: "/owner/quotations",
    required: false,
    feature: "quotations",
    group: "sell",
    doers: ADMINS_AND_SALES,
  },
  {
    id: "invoice",
    label: "Create your first invoice",
    blurb: "Bill a customer with GST worked out for you.",
    href: "/owner/invoices",
    required: false,
    feature: "invoices",
    group: "sell",
    doers: ADMINS,
  },
  {
    id: "billing",
    label: "Connect your payment account",
    blurb:
      "Add your own Razorpay keys so payments on your invoices settle into your account instead of the platform's.",
    href: "/owner/integrations/razorpay/connect",
    // NOT required any more (doc 26 Q10): it was owner-only in the API and shown
    // to managers as required, so a manager saw a required step they could not
    // do. And its absence changes nothing today - the platform's own gateway
    // already collects payment (migration 0060).
    required: false,
    feature: "invoices",
    group: "sell",
    doers: OWNER_ONLY,
  },
  {
    id: "report",
    label: "Build a report",
    blurb: "Put the numbers you check every week on one page, and have it emailed to you on a schedule.",
    href: "/owner/reports/builder",
    required: false,
    feature: "report_builder",
    // Doc 27's group table leaves this one unplaced; it sits with Sell because
    // every report source is the pipeline's own data.
    group: "sell",
    doers: ADMINS_AND_MARKETING,
  },
];

const BY_ID = new Map(SETUP_STEPS.map((step) => [step.id, step]));

export function setupStep(id: SetupStepId): SetupStepSpec | undefined {
  return BY_ID.get(id);
}

/** One tenant's provisioning, as the checklist needs to see it. */
export interface SetupEntitlement {
  modules: readonly string[];
  /** The client's own sparse switches (migration 0101), raw. */
  features: FeatureOverrides;
  /**
   * Which availability facts hold for this org on this deployment. Absent
   * means none - so a step that needs one is hidden, which is the safe
   * direction: an unofferable step shown is a button to an error page.
   */
  available?: readonly SetupAvailability[];
}

/**
 * The steps this particular client should see.
 *
 * A step with no gate is core Aura and always shows. One that names a feature,
 * a module or an availability fact shows only when all of them hold - see the
 * header for why that is not merely cosmetic.
 */
export function setupStepsFor(entitlement: SetupEntitlement): SetupStepSpec[] {
  // Resolved once rather than per step: `enabledFeatures` walks the whole
  // catalogue and its dependencies, and a filter would redo that work for
  // every row it tests.
  const on = enabledFeatures(entitlement.modules, entitlement.features);
  const available = new Set(entitlement.available ?? []);
  return SETUP_STEPS.filter(
    (step) =>
      (!step.feature || on.has(step.feature)) &&
      (!step.module || entitlement.modules.includes(step.module)) &&
      (!step.availability || available.has(step.availability)),
  );
}

/** Which steps are done. Absent means not done - a missing key is never a tick. */
export type SetupProgressMap = Partial<Record<SetupStepId, boolean>>;

/** Who is looking - the viewer rule in the header. */
export interface SetupViewer {
  role: OwnerRole;
  /** memberships.can_pair_devices (0107). Only the handset step reads it. */
  canPairDevices: boolean;
}

/** Can this viewer complete this step themselves? */
export function canDoSetupStep(step: SetupStepSpec, viewer: SetupViewer | null | undefined): boolean {
  // No viewer = the org's own view (the API deciding completeness): everything
  // is somebody's to do.
  if (!viewer) return true;
  if (step.id === "handset") return canPairDevices(viewer.role, viewer.canPairDevices);
  return step.doers.includes(viewer.role);
}

export interface SetupStepState extends SetupStepSpec {
  done: boolean;
  /** Skipped by an owner or manager. Never true for a required step. */
  skipped: boolean;
  /** The viewer can finish it themselves - see canDoSetupStep. */
  canDo: boolean;
}

export interface SetupState {
  /**
   * What is ALREADY running, measured (setup-readiness.ts). Rendered above the
   * outstanding steps: a client who has paired a handset and watched it record
   * two calls should be shown the product before the homework.
   *
   * Optional because `setupState()` is pure arithmetic over the catalogue and
   * has no facts to measure - the API attaches these from the same query that
   * answers the checklist.
   */
  readiness?: ReadinessLine[];
  /** Every visible step, skipped ones included (the page lists them apart). */
  steps: SetupStepState[];
  // ── the 0106 banner: required steps only ──
  requiredTotal: number;
  requiredDone: number;
  /** Every required step is ticked. Optional ones never hold this back. */
  complete: boolean;
  // ── the guide: every visible step, minus the skipped ones ──
  /** N in "X of N". */
  total: number;
  /** X in "X of N". */
  done: number;
  skipped: SetupStepId[];
  /** Every visible, non-skipped step is done. */
  guideComplete: boolean;
  /**
   * Where "Complete account setup" sends them: the first unfinished REQUIRED
   * step, or the first unfinished, unskipped optional one once the required
   * set is done. Null when there is genuinely nothing left.
   */
  nextHref: string | null;
  nextStepId: SetupStepId | null;
}

/**
 * Fold the catalogue, the completion map, the skips and the viewer into what
 * the console renders.
 *
 * Pure, so the banner's sentence, the modal's list, the sidebar meter and the
 * API's "is this org done" decision are all the same arithmetic. The
 * alternative - the API deciding `complete` and the console deciding what to
 * display - is how a banner ends up insisting on a step the modal shows as
 * ticked.
 */
export function setupState(
  entitlement: SetupEntitlement,
  progress: SetupProgressMap,
  options: { viewer?: SetupViewer | null; skipped?: readonly string[] } = {},
): SetupState {
  const skippedIds = new Set(options.skipped ?? []);
  const steps: SetupStepState[] = setupStepsFor(entitlement).map((step) => ({
    ...step,
    done: progress[step.id] === true,
    // A required step cannot be skipped. The API refuses to write one (409),
    // and a stray row - an old skip on a step that has since become required -
    // is ignored here rather than trusted.
    skipped: !step.required && skippedIds.has(step.id),
    canDo: canDoSetupStep(step, options.viewer),
  }));

  const required = steps.filter((s) => s.required);
  const requiredDone = required.filter((s) => s.done).length;
  const counted = steps.filter((s) => !s.skipped);
  const done = counted.filter((s) => s.done).length;
  const next = required.find((s) => !s.done) ?? counted.find((s) => !s.done) ?? null;

  return {
    steps,
    requiredTotal: required.length,
    requiredDone,
    complete: requiredDone === required.length,
    total: counted.length,
    done,
    skipped: steps.filter((s) => s.skipped).map((s) => s.id),
    guideComplete: done === counted.length,
    nextHref: next?.href ?? null,
    nextStepId: next?.id ?? null,
  };
}

/**
 * "2 required steps left" - the banner's count.
 *
 * It no longer says "{done} of {total}": with the guide's "X of N" on screen at
 * the same time, two different "of" numbers read as one of them being a bug.
 * The guide owns "X of N"; the banner says how many required steps remain.
 */
export function requiredStepsLeftText(state: Pick<SetupState, "requiredTotal" | "requiredDone">): string {
  const left = state.requiredTotal - state.requiredDone;
  return `${left} required step${left === 1 ? "" : "s"} left`;
}

/**
 * The banner's second line, built from what is actually left.
 *
 * Generated rather than written, because a fixed sentence goes stale the
 * moment one step is done: "Set up billing and upload a logo" is simply false
 * once the logo is uploaded, and a warning that describes the wrong problem
 * trains people to ignore warnings.
 *
 * The steps this viewer can do come first, as an instruction; the ones only
 * the owner can do follow as a second sentence about the owner. A manager told
 * "Complete the business profile to finish setting up" would go looking for a
 * form that refuses them.
 */
export function setupBannerDetail(state: SetupState): string {
  const outstanding = state.steps.filter((s) => s.required && !s.done);
  const mine = outstanding.filter((s) => s.canDo).map((s) => SHORT_ACTIONS[s.id]);
  const theirs = outstanding.filter((s) => !s.canDo).map((s) => SHORT_ACTIONS[s.id]);

  const sentences: string[] = [];
  if (mine.length) sentences.push(`${sentenceCase(joinPhrases(mine))} to finish setting up.`);
  if (theirs.length) {
    sentences.push(
      mine.length
        ? `Your owner still needs to ${joinPhrases(theirs)}.`
        : `Your owner still needs to ${joinPhrases(theirs)} to finish setting up.`,
    );
  }
  return sentences.join(" ");
}

function joinPhrases(phrases: string[]): string {
  if (phrases.length === 1) return phrases[0];
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/** Lower-case verb phrases, so they compose into one sentence. */
const SHORT_ACTIONS: Record<SetupStepId, string> = {
  handset: "pair a handset",
  team: "add a telecaller",
  logo: "upload your logo",
  business_profile: "complete the business profile",
  call_access_phone: "add a phone for call-access approvals",
  invite_colleague: "invite a colleague",
  roles: "review who can see what",
  commission: "set up a commission plan",
  transcription: "tune transcription",
  call_sop: "write a call procedure",
  agent: "build an AI agent",
  projects: "set up the project catalogue",
  lead_sources: "connect a lead source",
  meta_ads: "connect Facebook lead ads",
  whatsapp: "connect WhatsApp",
  mailbox: "connect an email inbox",
  lead_routing: "set up lead routing",
  outreach: "create a follow-up cadence",
  pipeline: "customise the pipeline",
  products: "add your products",
  import: "import your contacts",
  quotation: "create a quotation",
  invoice: "create an invoice",
  billing: "connect a payment account",
  report: "build a report",
};

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Who is shown the checklist and the guide.
 *
 * Owner and manager, the same pair that may act on most of it. A telecaller
 * cannot upload a logo, enroll a handset or connect a payment account - every
 * route behind these steps refuses them - so showing them a banner about it
 * would be a permanent notice about somebody else's job.
 */
export function seesSetupChecklist(role: OwnerRole): boolean {
  return OWNER_ROLE_ADMINS.includes(role);
}

/** The guide is open while it is neither finished nor hidden by an owner. */
export function setupGuideOpen(org: { guideCompletedAt: string | null; guideDismissedAt: string | null }): boolean {
  return !org.guideCompletedAt && !org.guideDismissedAt;
}
