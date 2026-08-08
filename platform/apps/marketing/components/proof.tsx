/**
 * Social proof.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️  BEFORE THIS GOES PUBLIC: GET THE CUSTOMER TO APPROVE THE WORDING.
 *
 * The substance below is real — both statements were relayed by the owner from
 * actual conversations with these two customers. THE SENTENCES ARE NOT. They
 * are written from what was reported, not transcribed from what was said, and
 * publishing a quotation mark around words a person did not say is
 * misrepresentation even when the substance is true.
 *
 * Send each customer their card and get a yes in writing. That is normal
 * practice for testimonial collection — companies draft, the customer approves
 * — and it also gets you the two things missing here: the speaker's NAME and
 * ROLE. "RD Interlock Bricks" is good; "Ramesh, owner, RD Interlock Bricks" is
 * markedly better, because a named human is harder to dismiss as invented.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ON THE "5x" ────────────────────────────────────────────────────────────
 *
 * It is the strongest thing on the whole page and the most dangerous. Read the
 * note in the RD Interlock entry before publishing, and read what the covering
 * message said about substantiation. It is quantified, attributed, and
 * currently unevidenced.
 *
 * Proof sits between the claims and the ask on purpose: a stranger has just
 * read six things Aura says about itself, and this is the only element on the
 * page that does not come from the seller.
 */

export interface Testimonial {
  quote: string;
  /** The speaker. Optional — company-only attribution is honest, but weaker. */
  name?: string;
  role?: string;
  company: string;
}

export const TESTIMONIALS: Testimonial[] = [
  {
    // ⚠️ QUANTIFIED CLAIM. "5x" is a specific commercial result and it is the
    // one line here that could be challenged. Two things before publishing:
    //
    //   1. Get it in writing from RD Interlock — an email saying it is fine to
    //      quote is enough. India's advertising rules expect a claim like this
    //      to be substantiable by whoever publishes it, and "he told me on the
    //      phone" is not a record.
    //   2. Confirm 5x of WHAT. Five times the conversion rate, or five times
    //      the number of converted leads? They are different numbers and the
    //      second is far easier to reach. The sentence below says conversion
    //      rate because that is what was reported; if it was volume, change it.
    //
    // If either is shaky, cut the number and keep the sentence. "Our conversion
    // rate went up" with a real name still outperforms no testimonial at all.
    quote:
      "Our conversion rate is five times what it was. We are not calling more people — " +
      "we finally know which calls are worth following up.",
    company: "RD Interlock Bricks",
  },
  {
    // No number in this one, and it needs none: it is the specific mechanism
    // the page has just spent two sections claiming — insights you can train
    // on, and objection handling that spreads across the team. A testimonial
    // that independently repeats the product's own argument is worth more than
    // one that praises it in general terms.
    quote:
      "The insights are what we train the team on now. Our objection handling is a different " +
      "thing from what it was, because everyone can see what actually worked on a real call.",
    company: "Fortune Innovatives",
  },
];

export function Proof() {
  if (TESTIMONIALS.length === 0) return null;

  return (
    <section className="mx-auto max-w-6xl px-5 pb-8 sm:px-6 sm:pb-12">
      <p className="mk-eyebrow mb-4">From people using it</p>
      <div className="grid gap-5 sm:grid-cols-2">
        {TESTIMONIALS.map((t) => (
          <figure key={t.company} className="mk-card p-7">
            <span
              className="mb-5 block h-1 w-10 rounded-full"
              style={{ background: "var(--brand-gradient)" }}
              aria-hidden="true"
            />
            <blockquote className="text-[1.0625rem] leading-relaxed">
              &ldquo;{t.quote}&rdquo;
            </blockquote>
            <figcaption className="mt-5 text-sm">
              {/* Company-only until the names arrive. Rendering "— , RD
                  Interlock Bricks" with an empty name would look broken, so the
                  name and role are only printed when they exist. */}
              {t.name ? (
                <>
                  <span className="font-semibold">{t.name}</span>
                  <span style={{ color: "var(--mk-muted)" }}>
                    {t.role ? `, ${t.role}` : ""}, {t.company}
                  </span>
                </>
              ) : (
                <span className="font-semibold">{t.company}</span>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
