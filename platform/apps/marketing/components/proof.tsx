import Image from "next/image";

/**
 * Social proof.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️  BEFORE THIS GOES PUBLIC: GET EACH CUSTOMER TO APPROVE THE WORDING.
 *
 * The substance below is real - every statement was relayed by the owner from
 * an actual conversation with that customer. THE SENTENCES ARE NOT. They are
 * written from what was reported, not transcribed from what was said, and
 * publishing a quotation mark around words a person did not say is
 * misrepresentation even when the substance is true.
 *
 * Send each customer their card and get a yes in writing. That is normal
 * practice for testimonial collection - companies draft, the customer approves
 * - and it also gets you the thing still missing here: the speaker's NAME and
 * ROLE. "RD Interlock Bricks" is good; "Ramesh, owner, RD Interlock Bricks" is
 * markedly better, because a named human is harder to dismiss as invented.
 * The card renders the name and role the moment they are filled in.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ON THE "5x" ────────────────────────────────────────────────────────────
 *
 * It is the strongest thing on the whole page and the most dangerous. Read the
 * note in the RD Interlock entry before publishing. It is quantified,
 * attributed, and currently unevidenced.
 *
 * Proof sits between the claims and the ask on purpose: a stranger has just
 * read six things Auratel says about itself, and this is the only element on
 * the page that does not come from the seller.
 */

export interface Testimonial {
  quote: string;
  /** The speaker. Optional - company-only attribution is honest, but weaker. */
  name?: string;
  role?: string;
  company: string;
  /**
   * The customer's mark, as a path under `public/`.
   *
   * DROP THE FILE AND SET THIS. Nothing generates it, nothing fetches it, and
   * a path to a file that does not exist renders a broken image rather than
   * failing a build - so the card falls back to the company's initials
   * whenever this is absent, which is a deliberate-looking state rather than a
   * gap. Square-ish artwork works best; see `logoFit` for the two kinds.
   */
  logo?: string;
  /**
   * How the mark fills its circle. Default `contain`.
   *
   * Per-customer because the three marks supplied on 2026-10-13 are three
   * different kinds of artwork:
   *
   *   · `contain` - a mark with a transparent or white background. Fitted
   *     whole inside the circle with padding, so nothing is cropped. Right for
   *     an icon or a small lockup.
   *   · `cover` - artwork with its OWN background baked in, such as a logo
   *     sitting on a photograph. `contain` would drop a visible square of that
   *     background inside the circle, which reads as a mistake; `cover` fills
   *     the circle and crops the corners, which is what the eye expects.
   *
   * Neither setting rescues a WIDE WORDMARK: fitted whole it becomes an
   * illegible strip across the middle of the circle, and cropped to fill it
   * loses the words entirely. For a wordmark, ask the customer for the
   * icon-only variant - most brands have one, and it is the left-hand glyph of
   * the lockup they already sent.
   */
  logoFit?: "contain" | "cover";
}

export const TESTIMONIALS: Testimonial[] = [
  {
    // ⚠️ QUANTIFIED CLAIM. "5x" is a specific commercial result and it is the
    // one line here that could be challenged. Two things before publishing:
    //
    //   1. Get it in writing from RD Interlock - an email saying it is fine to
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
      "Our conversion rate is five times what it was. We are not calling more people, " +
      "we finally know which calls are worth following up.",
    company: "RD Interlock Bricks",
    logo: "/testimonials/rd-interlock-bricks.png",
    // `cover`, because the artwork is a photograph of a brick wall with the
    // monogram painted over it. Fitted whole, that grey rectangle would sit as
    // a visible square inside a round frame. Filling the circle crops the
    // "INTERLOCK BRICKS" wordmark off the bottom and leaves the RD monogram,
    // which is the recognisable part and the part that survives at 80px.
    logoFit: "cover",
  },
  {
    // No number in this one, and it needs none: it is the specific mechanism
    // the page has just spent two sections claiming - insights you can train
    // on, and objection handling that spreads across the team. A testimonial
    // that independently repeats the product's own argument is worth more than
    // one that praises it in general terms.
    quote:
      "The insights are what we train the team on now. Our objection handling is a different " +
      "thing from what it was, because everyone can see what actually worked on a real call.",
    company: "Fortune Innovatives",
    // CROPPED, not the file as supplied. What arrived was the full lockup: a
    // 371x52 navy bar with the words "FORTUNE INNOVATIVES" beside a cube
    // glyph, which in a circle is an unreadable strip. The glyph is the left
    // 52x52 of that bar, so it was cut out with
    //     ffmpeg -i <src> -vf "crop=52:52:0:0" fortune-innovatives.png
    // and the result is a square mark on its own navy ground.
    logo: "/testimonials/fortune-innovatives.png",
    // `cover`, so the navy fills the circle. With `contain` the navy square
    // would float inside a white circle with four pale corners showing.
    logoFit: "cover",
  },
  {
    // Added 2026-10-13, relayed by the owner like the two above, and carrying
    // the SAME outstanding obligation: these are not the customer's own words,
    // so send them the card and get a written yes before it goes public.
    //
    // Easier to stand behind than the first one, and worth saying why: there is
    // no number in it. "We allocate resources differently" is a claim about how
    // they now decide, which is theirs to make and ours only to quote.
    //
    // It also earns its place rather than repeating the others. The first is
    // about conversion, the second about coaching, and this one is about a
    // decision an owner makes OUTSIDE the calling floor - where to put people
    // and money. That is the argument for the insights and reporting screens,
    // which neither of the other two makes.
    quote:
      "The data out of Auratel gave us an insight into the business we simply did not have. " +
      "The decisions we have made off the back of it are some of the most valuable we have " +
      "made, and our resources now go where they are actually needed.",
    company: "TNPSC Mentors",
    logo: "/testimonials/tnpsc-mentors.png",
    // `contain` - the mark has its own light background and sits whole inside
    // the circle with padding.
    //
    // ⚠️ THE SOURCE IS 58x40, WHICH IS TOO SMALL. The circle renders at 80px
    // and is served at 2x for a retina screen, so this is being scaled past
    // twice its native size and will look soft. Nothing can recover detail
    // that is not in the file: ask TNPSC Mentors for the original, at 160px or
    // more on the short side, and overwrite the file. No code changes with it.
    logoFit: "contain",
  },
];

/**
 * Initials, for a customer whose mark has not been supplied yet.
 *
 * Two letters from two words, one from a single word. A circle with "TM" in it
 * reads as a considered placeholder; an empty circle, or a broken-image icon,
 * reads as a page that was not finished.
 */
function initials(company: string): string {
  const words = company.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * The organic shape behind each card.
 *
 * ── WHY THE BRAND GRADIENT AND NOT THE REFERENCE'S THREE COLOURS ──────────
 *
 * The design the owner supplied puts a different colour behind each card -
 * blue, green, teal. This uses the one brand gradient for all three, at low
 * opacity, rotated differently per card. brand.css states the rule it would
 * otherwise break: the gradient is the brand's single loud move, and the
 * moment it spreads it stops reading as identity and starts reading as
 * decoration. Introducing a green and a teal that appear nowhere else on the
 * site would do exactly that, and on a page whose console screenshots are
 * blue-violet it would read as three unrelated products.
 *
 * The shape is a lopsided border-radius rather than an SVG or an image: four
 * different corner radii on each axis give the soft blob the reference has,
 * it costs no bytes, and it scales with the card instead of being a fixed
 * raster behind a fluid box.
 */
function Blob({ index }: { index: number }) {
  // Three arrangements, so the row does not read as one shape stamped out
  // three times. Each pushes the blob out from a different corner.
  const layouts = [
    { inset: "-6% -10% 6% -4%", radius: "58% 42% 38% 62% / 46% 54% 46% 54%", rotate: "-6deg" },
    { inset: "4% -8% -6% -8%", radius: "42% 58% 62% 38% / 54% 42% 58% 46%", rotate: "5deg" },
    { inset: "-5% -4% 5% -10%", radius: "52% 48% 44% 56% / 38% 62% 38% 62%", rotate: "-3deg" },
  ];
  const l = layouts[index % layouts.length]!;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -z-10 block"
      style={{
        inset: l.inset,
        borderRadius: l.radius,
        transform: `rotate(${l.rotate})`,
        background: "var(--brand-gradient)",
        // Low enough that the near-black quote above it stays well clear of
        // AA, and that the card's own white reads as lifted off it.
        opacity: 0.22,
      }}
    />
  );
}

export function Proof() {
  if (TESTIMONIALS.length === 0) return null;

  return (
    <section className="mx-auto max-w-6xl px-5 pb-8 sm:px-6 sm:pb-12">
      <p className="mk-eyebrow mb-4">From people using it</p>

      {/* The top padding is the avatar's: it hangs half outside the card, so
          the row needs room above the cards or the first one clips under the
          section before it. */}
      <div className="grid gap-x-5 gap-y-16 pt-12 sm:grid-cols-2 lg:grid-cols-3">
        {TESTIMONIALS.map((t, i) => (
          <figure key={t.company} className="relative">
            <Blob index={i} />

            {/* `pt-14` leaves room for the avatar overlapping the top edge.
                Centred text, which is the reference's composition and is only
                right because these are three or four lines each - a centred
                paragraph any longer is hard to read. */}
            <div className="mk-card relative h-full px-6 pb-7 pt-14 text-center">
              {/* Half above the card, centred on its top edge. */}
              <span
                className="absolute left-1/2 top-0 grid h-20 w-20 -translate-x-1/2 -translate-y-1/2 place-items-center overflow-hidden rounded-full"
                style={{
                  background: "var(--mk-surface)",
                  border: "1px solid var(--mk-line)",
                  boxShadow: "var(--mk-shadow)",
                }}
              >
                {t.logo ? (
                  <Image
                    src={t.logo}
                    // Empty on purpose: the company name is the next thing a
                    // screen reader reads, and alt text here would say it
                    // twice. The mark carries no information the caption does
                    // not already carry.
                    alt=""
                    width={80}
                    height={80}
                    className={
                      t.logoFit === "cover"
                        ? "h-full w-full object-cover"
                        : "h-full w-full object-contain p-3"
                    }
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="text-lg font-semibold tracking-wide"
                    style={{ color: "var(--mk-muted)" }}
                  >
                    {initials(t.company)}
                  </span>
                )}
              </span>

              <figcaption>
                {/* The heading is the NAME when there is one and the company
                    when there is not, because a person is the stronger
                    attribution and the company then moves to the line below.
                    Until the names arrive this reads as the company alone,
                    which is honest and simply weaker. */}
                <p className="text-[1.375rem] font-medium leading-tight">
                  {t.name ?? t.company}
                </p>
                {t.name ? (
                  <p className="mt-1 text-sm italic" style={{ color: "var(--mk-muted)" }}>
                    {t.role ? `${t.role}, ` : ""}
                    {t.company}
                  </p>
                ) : null}
              </figcaption>

              <span
                className="mx-auto my-5 block h-px w-10"
                style={{ background: "var(--mk-line)" }}
                aria-hidden="true"
              />

              <blockquote className="text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
                &ldquo;{t.quote}&rdquo;
              </blockquote>
            </div>
          </figure>
        ))}
      </div>
    </section>
  );
}
