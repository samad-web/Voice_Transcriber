import { LeadStages, type LeadStages as LeadStagesType } from "./leads";

/**
 * READY-MADE BOARDS, BY WHAT THE BUSINESS ACTUALLY DOES.
 *
 * ── WHAT EXISTS TODAY ───────────────────────────────────────────────────────
 *
 * One pipeline, seeded identically for every tenant (migration 0034):
 * New → Contacted → Qualified → Negotiation → Won → Lost. Those are the names
 * of a sales methodology, not of anything that happens in a dental clinic, a
 * property office or a coaching centre - and a board whose columns describe
 * somebody else's job is a board nobody moves cards on. The columns then sit
 * there being wrong, and the CRM quietly becomes a list.
 *
 * ── WHY THE PACK CARRIES THE `terminal` FLAG, NOT JUST THE NAMES ────────────
 *
 * A pack that only renamed the columns would trade a wrong board for a
 * good-looking board that is equally dead. `terminal` is what tells the rest of
 * the product that a card in "Appointment booked" means WON - it drives
 * `statusForStage`, the won/lost reporting, and the one automatic stage move.
 * Rename without it and every clinic's dashboard reports a 0% close rate.
 *
 * ── WHY THE MATCH IS A REGEX AND NOT A MODEL ────────────────────────────────
 *
 * DeskcommCRM (MIT, Rafael Melgaco), which this is adapted from
 * (`lib/onboarding/pacotes-de-funil.ts` and `sugerir-funil.ts`), asks an LLM to
 * generate a board and falls back to these packs on every bad outcome - no key,
 * no credit, prose instead of JSON, a funnel with two "won" columns.
 *
 * Only the fallback half is ported. That is a deliberate narrowing, not an
 * oversight: the fallback is where the value is - it is what runs in the
 * overwhelming majority of cases even in the original - and a generation call
 * here would need a provider decision, a per-tenant cost, and a prompt to
 * maintain, to improve on a list somebody can edit in the console in ten
 * seconds. The packs are also the RULER the original compares a generated
 * answer against, so they have to exist first either way.
 *
 * ── THE VOCABULARY IS THE OWNER'S, NOT A SALES MANUAL'S ─────────────────────
 *
 * No "prospecting", no "MQL", no "top of funnel". Every column below is a
 * moment somebody would describe out loud: "quote sent", "site visit done",
 * "waiting for payment".
 */

export interface StagePack {
  id: string;
  /**
   * How an owner recognises their OWN business in a list - not the name of a
   * market vertical. "Clinic, dental practice or salon", not "healthcare".
   */
  label: string;
  /** What the board gets called. */
  pipelineName: string;
  stages: LeadStagesType;
}

export const STAGE_PACKS: readonly StagePack[] = [
  {
    id: "clinic",
    label: "Clinic, dental practice, salon or diagnostic centre",
    pipelineName: "Appointments",
    stages: [
      { key: "new", label: "New enquiry" },
      { key: "contacted", label: "Called back" },
      { key: "qualifying", label: "Understanding the case" },
      { key: "qualified", label: "Wants an appointment" },
      { key: "negotiation", label: "Picking a slot" },
      { key: "won", label: "Appointment booked", terminal: "won" },
      { key: "lost", label: "Not booking", terminal: "lost" },
    ],
  },
  {
    id: "property",
    label: "Property, real estate or builder",
    pipelineName: "Enquiries",
    stages: [
      { key: "new", label: "New enquiry" },
      { key: "contacted", label: "Called back" },
      { key: "qualifying", label: "Budget and area understood" },
      { key: "qualified", label: "Shortlisted properties" },
      { key: "negotiation", label: "Site visit done" },
      { key: "won", label: "Booked", terminal: "won" },
      { key: "lost", label: "Dropped", terminal: "lost" },
    ],
  },
  {
    id: "services",
    label: "Services, agency, contractor or interiors",
    pipelineName: "Quotations",
    stages: [
      { key: "new", label: "New request" },
      { key: "contacted", label: "Called back" },
      { key: "qualifying", label: "Scoping the work" },
      { key: "qualified", label: "Quote sent" },
      { key: "negotiation", label: "Negotiating" },
      { key: "won", label: "Work confirmed", terminal: "won" },
      { key: "lost", label: "Did not go ahead", terminal: "lost" },
    ],
  },
  {
    id: "education",
    label: "Coaching centre, college, course or training",
    pipelineName: "Admissions",
    stages: [
      { key: "new", label: "New enquiry" },
      { key: "contacted", label: "Counsellor called" },
      { key: "qualifying", label: "Course and batch discussed" },
      { key: "qualified", label: "Wants to join" },
      { key: "negotiation", label: "Fees and documents" },
      { key: "won", label: "Admitted", terminal: "won" },
      { key: "lost", label: "Did not join", terminal: "lost" },
    ],
  },
  {
    id: "retail",
    label: "Shop, dealership, distributor or online store",
    pipelineName: "Orders",
    stages: [
      { key: "new", label: "New enquiry" },
      { key: "contacted", label: "Called back" },
      { key: "qualifying", label: "Choosing the product" },
      { key: "qualified", label: "Ready to buy" },
      { key: "negotiation", label: "Awaiting payment" },
      { key: "won", label: "Order placed", terminal: "won" },
      { key: "lost", label: "Did not buy", terminal: "lost" },
    ],
  },
  {
    id: "finance",
    label: "Insurance, loans, investments or financial advice",
    pipelineName: "Applications",
    stages: [
      { key: "new", label: "New enquiry" },
      { key: "contacted", label: "Called back" },
      { key: "qualifying", label: "Needs understood" },
      { key: "qualified", label: "Plan proposed" },
      { key: "negotiation", label: "Documents in progress" },
      { key: "won", label: "Policy issued", terminal: "won" },
      { key: "lost", label: "Did not proceed", terminal: "lost" },
    ],
  },
  {
    id: "general",
    // Last on purpose: anybody who does not recognise themselves above has
    // already read every other option by the time they reach this one.
    label: "Something else",
    pipelineName: "Sales Pipeline",
    stages: [
      { key: "new", label: "New" },
      { key: "contacted", label: "Contacted" },
      { key: "qualified", label: "Qualified" },
      { key: "negotiation", label: "Negotiation" },
      { key: "won", label: "Won", terminal: "won" },
      { key: "lost", label: "Lost", terminal: "lost" },
    ],
  },
] as const;

/**
 * The last-resort pack, as a CONSTANT rather than `STAGE_PACKS[0]`.
 *
 * A fixed index into an editable list is the promise that breaks on the first
 * reorder, and the failure would be a console rendering `undefined` where a
 * board should be. Throwing at module load is the loud version of that, which
 * is the one worth having.
 */
export const DEFAULT_PACK: StagePack =
  STAGE_PACKS.find((p) => p.id === "general") ??
  (() => {
    throw new Error("STAGE_PACKS is missing its general pack - the fallback every path relies on");
  })();

/**
 * Words an owner would use about themselves, not names of market verticals.
 *
 * Ordered, and the order is the tie-break: a business describing itself as a
 * "dental clinic and diagnostic lab" matches clinic first because clinic is
 * listed first. Stable, rather than dependent on object key order over user
 * input - which is the kind of thing that works until somebody's description
 * changes one word.
 */
const HINTS: Array<{ id: string; pattern: RegExp }> = [
  {
    id: "clinic",
    pattern:
      /\b(clinic|dental|dentist|doctor|hospital|diagnos|physio|derma|ayurved|homeopath|salon|spa|parlour|parlor|veterinar|pet care|nutrition|therapist|counsell?or)\w*/i,
  },
  {
    id: "property",
    pattern: /\b(property|properties|real ?estate|realtor|realty|builder|flat|apartment|villa|plot|land|rent|lease|broker)\w*/i,
  },
  {
    id: "education",
    pattern:
      /\b(coaching|tuition|tutor|school|college|univers|academy|institute|course|training|edtech|admission|classes|neet|jee|upsc|ielts)\w*/i,
  },
  {
    id: "finance",
    pattern: /\b(insur|loan|mortgage|mutual fund|invest|wealth|financ|lending|nbfc|policy|policies|demat|broking)\w*/i,
  },
  {
    id: "services",
    pattern:
      /\b(agency|consult|interior|architect|contractor|construction|renovat|plumb|electric|repair|service|maintenance|catering|event|photograph|legal|advocate|chartered accountant|\bca\b)\w*/i,
  },
  {
    id: "retail",
    pattern: /\b(shop|store|retail|dealer|dealership|distribut|wholesal|showroom|boutique|ecommerce|e-commerce|garment|textile|furnitur|electronics)\w*/i,
  },
];

/**
 * The pack whose vocabulary best matches how this business describes itself.
 *
 * Always returns something: an empty or unrecognised description gets the
 * general pack, which is the board they would have had anyway. A suggestion is
 * a starting point somebody edits, so being wrong costs a few seconds - being
 * ABSENT costs them the whole feature.
 */
export function suggestPack(description: string): StagePack {
  const text = description ?? "";
  for (const hint of HINTS) {
    if (hint.pattern.test(text)) {
      const pack = STAGE_PACKS.find((p) => p.id === hint.id);
      if (pack) return pack;
    }
  }
  return DEFAULT_PACK;
}

export function packById(id: string): StagePack | undefined {
  return STAGE_PACKS.find((p) => p.id === id);
}

/**
 * Is this a board the rest of the product can actually run on?
 *
 * Checked rather than trusted, because these stages are applied to a live
 * pipeline and the failures are silent ones: a board with no `won` column
 * reports every tenant at a 0% close rate, and one with two makes the won/lost
 * split ambiguous everywhere it is summed. `LeadStages` already caps the count
 * and shapes each entry; this adds the rules that are about the SET.
 */
export function validatePack(stages: unknown): { ok: true; stages: LeadStagesType } | { ok: false; errors: string[] } {
  const parsed = LeadStages.safeParse(stages);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  }

  const errors: string[] = [];
  const won = parsed.data.filter((s) => s.terminal === "won");
  const lost = parsed.data.filter((s) => s.terminal === "lost");
  if (won.length !== 1) errors.push(`a board needs exactly one won column, found ${won.length}`);
  if (lost.length !== 1) errors.push(`a board needs exactly one lost column, found ${lost.length}`);

  const keys = parsed.data.map((s) => s.key);
  if (new Set(keys).size !== keys.length) errors.push("two columns share a key");

  // The terminal columns at the end. Not cosmetic: `entryStage` takes the
  // first NON-terminal column as where a new lead lands, so a board opening
  // with "Lost" would be merely odd - but a board whose only non-terminal
  // columns sit after the terminal ones reads backwards to everyone using it.
  const firstTerminal = parsed.data.findIndex((s) => s.terminal);
  if (firstTerminal !== -1 && parsed.data.slice(firstTerminal).some((s) => !s.terminal)) {
    errors.push("the won and lost columns must come last");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, stages: parsed.data };
}
