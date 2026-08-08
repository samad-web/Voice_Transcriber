import { Section, SectionHeading, Card } from "../ui/layout";
import { WhatsAppCta } from "../ui/whatsapp-cta";
import { WA_MESSAGES } from "@/lib/site";

/**
 * Pricing — structure only, no numbers.
 *
 * Doc 10 §6 is emphatic that hiding pricing is fatal for an SMB buyer, AND that
 * tier numbers must not be published until §4.1 billing can enforce them. Those
 * two instructions point in opposite directions right now, and the tie-breaker
 * is doc 10 §14: "Every claim on the page is true of the deployed build today."
 * A published ₹ figure the platform cannot meter, cap or invoice against is a
 * claim, and a load-bearing one.
 *
 * So this section publishes the *unit* and the *shape* — which is the part the
 * buyer actually needs to reason about, and which is true today — and says
 * plainly that the numbers are not up yet. That is a materially better page
 * than "Contact us", and it is honest.
 *
 * The tier names and inclusions come from doc 10 §6's table.
 *
 * ── Why every tier now has two lists ──────────────────────────────────────
 *
 * Doc 18 §5 caught this section advertising, in the present tense, capabilities
 * that are roadmap rows in `09_FEATURE_CATALOGUE.md` rather than shipped code.
 * The same §14 gate that stopped us printing a ₹ figure applies here: a feature
 * bullet is a claim, and the one place on this site where a reader's trust would
 * have been misplaced was the one section they read hardest.
 *
 * They are MARKED, not deleted. A visible "Coming soon" is honest and still
 * sells the direction; deleting loses real signal about where the product goes
 * next, which for an SMB buyer choosing a vendor for three years is information
 * they actually want. The treatment is a labelled block plus muted body text,
 * not a parenthetical — a skimmer has to be able to tell the two lists apart
 * without reading a word of either.
 *
 * `included` was checked against source, one bullet at a time, not against the
 * docs:
 *
 *  · Transcription, lead extraction, CRM connectors — the whole shipped
 *    pipeline (`apps/worker/src/pipeline/*`, 15 `category: "crm"` specs in
 *    `packages/shared/src/crm-providers.ts`).
 *  · Telecaller performance — SHIPPED, and doc 18 §5 is wrong to list it as
 *    roadmap. `owner.controller.ts` computes calls, talk seconds, leads, won
 *    and pipeline value per handset over a rolling window, migration 0017 gives
 *    the telecaller a durable identity that survives handset reassignment, and
 *    `apps/web/app/(owner)/owner/page.tsx` renders it under a heading that
 *    literally reads "Telecaller performance". Trust the code.
 *  · API access — `apps/api/src/modules/auth/apikeys.controller.ts` plus the
 *    `(platform)/api-keys` console route.
 *  · Custom retention — `organizations.retention_days` (migration 0001) is
 *    enforced by `apps/worker/src/pipeline/reaper.ts`.
 *
 * And what moved to `roadmap`, with the reason it could not stay:
 *
 *  · Objection and price intelligence — the diarizer tags a *per-turn* intent
 *    and a tenant can define an `objections` extraction field, but nothing
 *    aggregates either across calls. There is no such surface in the console,
 *    so "intelligence" is not a thing you can buy today.
 *  · WhatsApp digests — zero WhatsApp send path anywhere in `apps/api`,
 *    `apps/worker` or `packages/*`. The site's own WhatsApp CTA is a `wa.me`
 *    deep link, which is not a delivery channel we operate.
 *  · Multi-branch — no branch/site concept in any migration; the tenancy model
 *    is org → instance → device and stops there.
 *  · Your own AI provider keys — no migration carries a per-org provider key;
 *    `packages/db/src/secrets.ts` holds platform credentials, not tenant ones.
 *
 * Single sign-on was removed from the closing paragraph for the same reason:
 * there is no SAML or OIDC path in the codebase, and "that is a conversation"
 * still implies we can deliver it. A DPA, custom retention and a capture SLA
 * are all things a human can actually commit to, so those stay.
 */
type Tier = {
  name: string;
  shape: string;
  /** True of the deployed build today. Doc 10 §14. */
  included: string[];
  /** Real direction, not yet real product. Rendered as clearly not-yet. */
  roadmap?: string[];
};

const TIERS: Tier[] = [
  {
    name: "Starter",
    shape: "Up to 5 handsets",
    included: [
      "Transcription and lead extraction",
      "One CRM connector",
      "Your own retention window",
    ],
  },
  {
    name: "Growth",
    shape: "Up to 25 handsets",
    included: [
      "Everything in Starter",
      "Telecaller performance, calls, talk time, leads and pipeline value per handset",
    ],
    roadmap: ["Objection and price intelligence", "WhatsApp digests"],
  },
  {
    name: "Business",
    shape: "25+ handsets",
    included: ["Everything in Growth", "API access", "Priority support"],
    roadmap: ["Multi-branch", "Your own AI provider keys"],
  },
];

export function Pricing() {
  return (
    <Section id="pricing" tone="subtle" labelledBy="pricing-heading">
      <SectionHeading
        id="pricing-heading"
        eyebrow="Pricing"
        title="Priced per handset, per month"
        lead="That is the unit you already think in, and it is the one that drives the real cost, a handset makes calls, and calls cost transcription and AI time."
      />

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        {TIERS.map((t) => {
          const roadmapLabelId = `pricing-${t.name.toLowerCase()}-roadmap`;
          return (
            <Card key={t.name} className="flex flex-col">
              <h3 className="text-xl font-semibold text-text">{t.name}</h3>
              <p className="mt-1 text-base text-text-muted">{t.shape}</p>
              <p className="mt-4 text-2xl font-semibold text-text">
                ₹, {" "}
                <span className="text-base font-normal text-text-muted">
                  per handset / month
                </span>
              </p>

              <ul className="mt-5 space-y-2">
                {t.included.map((item) => (
                  <li key={item} className="flex gap-2 text-base text-text">
                    {/* Glyph, not colour alone — doc 16 §2.1. -text tier
                        because --color-success is the graphic tier and fails AA
                        the moment it sits next to words. */}
                    <span aria-hidden="true" className="text-success-text">
                      ✓
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>

              {t.roadmap ? (
                <div
                  role="group"
                  aria-labelledby={roadmapLabelId}
                  className="mt-5 border-t border-border pt-4"
                >
                  <p
                    id={roadmapLabelId}
                    className="inline-flex items-center rounded-full border border-border bg-bg-subtle px-2.5 py-0.5 text-xs font-medium text-text-muted"
                  >
                    Coming soon, not in the product today
                  </p>
                  <ul className="mt-3 space-y-2">
                    {t.roadmap.map((item) => (
                      <li key={item} className="text-base text-text-muted">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <p className="mt-6 max-w-3xl text-base text-text-muted">
        Ticked rows work in the product you would be switched on to this week.
        Anything under "Coming soon" is on the roadmap and is not built yet, we
        would rather tell you that here than after you have paid for it.
      </p>

      <div className="mt-8 max-w-3xl rounded-lg border border-border bg-surface p-6">
        <p className="text-lg font-medium text-text">
          The numbers are not published yet, and we are not going to invent them.
        </p>
        <p className="mt-3 text-base text-text-muted">
          Every plan will include a fair-use call allowance with a stated overage
          rate, because transcription and AI time are the real cost and pretending
          otherwise ends in a bill nobody expected. We are not publishing the
          per-handset figures until the platform can meter and enforce them, until then, ask, and you will get a straight answer for your team size
          on the first message.
        </p>
        <div className="mt-5">
          <WhatsAppCta message={WA_MESSAGES.pricing}>
            Ask what it costs for your team
          </WhatsAppCta>
        </div>
      </div>

      <p className="mt-6 max-w-3xl text-base text-text-muted">
        Larger teams needing a negotiated data processing agreement, a custom
        retention window or a capture SLA: those are a conversation, not a plan.
      </p>
    </Section>
  );
}
