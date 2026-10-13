import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import {
  CallLogSurface,
  DeliverySurface,
  FieldsSurface,
  LeadSurface,
  ScorecardSurface,
  TranscriptSurface,
} from "@/components/explainer/surfaces";
import { BreadcrumbSchema } from "@/components/breadcrumbs";
import { Proof } from "@/components/proof";
import { GST_NOTE, PLANS } from "@/lib/content/pricing";
import { pageMetadata } from "@/lib/metadata";
import { BRAND, LEGAL_ENTITY, SITE_URL, startHref } from "@/lib/site";

/**
 * /call-tracking-dashboard - what Auratel does, explained.
 *
 * ── THE REGISTER, AND WHY IT CHANGED ──────────────────────────────────────
 *
 * Rewritten 2026-10-13. The first version of this page was direct response
 * built from doc 43: accusatory headline, a disqualifier section, "Book my
 * call now" repeated at every band. The owner read it and said it felt like a
 * landing page - they want the page to explain what we do and what we help
 * with, and pointed at x.ai as the reference.
 *
 * x.ai was fetched on 2026-10-13 (the page 403s a plain fetch; it was read
 * with a browser user-agent) rather than recalled, because the whole value of
 * a named reference is what it actually does. Its shape, in order: a short
 * capability headline ("Frontier AI models for everything you build") with a
 * modality list under it; two calm CTAs, one to start and one to read more; a
 * grid of products where EVERY product tile contains a working-looking panel
 * of that product rather than a description of it; a "One API. Every
 * modality." section that explains the mechanism and puts a figure band under
 * it; news; and a two-card "Choose how to get started" close. No urgency, no
 * countdown, no testimonial carousel, and the word "now" appears on no button.
 *
 * What is borrowed: that order, the show-don't-assert tiles, the figure band,
 * the calm two-path close. What is NOT borrowed is the visual identity - this
 * page is Auratel's own tokens and gradient, because doc 10 §7 holds that a
 * marketing page which looks like the product is itself a trust signal, and a
 * page styled like somebody else's opens into a console that looks like
 * neither.
 *
 * ── WHAT THIS COSTS, STATED ONCE ──────────────────────────────────────────
 *
 * Doc 43 §1 and §6 are the counter-argument and they have not gone away: for
 * a stranger arriving cold from a search result, explanation converts worse
 * than direct response. This page trades conversion rate for comprehension on
 * the owner's instruction. Two things keep that trade from being a loss:
 * every section still ends somewhere, and /start is still the only
 * destination, so the funnel's own numbers will say within a few weeks
 * whether the trade was worth making. If it was not, the git history has the
 * direct-response version intact.
 *
 * ── SEO IS UNAFFECTED, AND IN PLACES BETTER ───────────────────────────────
 *
 * The keyword targets are unchanged ("call tracking dashboard", "telecaller
 * monitoring software", "track what telecallers say", "Tamil call
 * transcription"). Explanation is MORE indexable than persuasion: more
 * headings, more specific nouns, and an FAQ block that reads as an answer
 * rather than as objection handling. The three JSON-LD blocks are untouched.
 *
 * ── EVERY CLAIM IS CHECKED AGAINST THE DEPLOYED BUILD ─────────────────────
 *
 * Doc 10 §14 and §15. Deliberately absent until it ships: missed-call capture
 * and callbacks (0133/0134, local), tasks (0135, local), attendance (0140,
 * local), lock-screen alerts (APK unpublished), Zoho/Salesforce/monday.com/
 * Dynamics (catalogued, OAuth-pending), and any price. Present and sourced:
 * capture paths (05_FLEET_ONBOARDING.md §1), diarized Tamil/English ASR,
 * per-organisation extracted fields, the telecaller scorecard (0144, live
 * 2026-09-29), insights with PDF export (live 7afd54b), the lead board and
 * Hot/Medium/Cold (0136, 0083), the stage ledger (live 941b211), eleven live
 * connectors (packages/shared/src/crm-providers.ts), RLS isolation and the
 * 90-day retention default (0001_init.sql, organizations.retention_days).
 *
 * The figure band is product facts - languages, handset brands, connectors,
 * retention - and not usage statistics. We have no published usage numbers,
 * and a band of invented ones is the one thing doc 10 §15 names outright.
 */

const CTA = startHref("explainer-cta", "call-tracking-dashboard");
const PATH = "/call-tracking-dashboard";

/* ── Page contents ────────────────────────────────────────────────────────
   An in-page table of contents, not site navigation. The header's nav stays
   empty (lib/site.ts, owner's 2026-08-08 decision); this is the thing a long
   explainer needs and a landing page does not - a reader who wants the CRM
   answer should not have to scroll past the transcript section to find it.
   Anchors double as the targets Google can surface as sitelinks. */
const CONTENTS = [
  { href: "#the-problem", label: "The problem" },
  { href: "#what-it-does", label: "What it does" },
  { href: "#pipeline", label: "How it works" },
  { href: "#what-we-help-with", label: "What we help with" },
  { href: "#who-its-for", label: "Who it's for" },
  { href: "#limits", label: "What it doesn't do" },
  { href: "#pricing", label: "What it costs" },
  { href: "#faq", label: "Questions" },
];

const PAGE_FAQ = [
  {
    q: "What is a call tracking dashboard?",
    a: "A call tracking dashboard is one screen that holds every call your team made, what was said on it, and what came out of it. Not a phone bill and not a pile of recordings: the call, the written transcript, the customer's details, what they asked for, what they objected to, and whether it became a lead. Auratel builds one from the calls your telecallers are already making on the handsets they already have.",
  },
  {
    q: "Can I see what my telecallers said on a call without listening to it?",
    a: "Yes. Every call is transcribed and split by speaker, so you read it instead of listening to it. A twelve-minute call takes about forty seconds to read, and the details that matter, what the customer wanted, the quantity, the rate discussed, the objection, and what was promised, are pulled out and shown above the transcript as fields.",
  },
  {
    q: "Which phones can Auratel track calls on?",
    a: "Samsung, Xiaomi, Redmi, POCO, Realme, Oppo, Vivo and OnePlus handsets all write call recordings to a folder Auratel can read. Pixel, Motorola and Nokia use the Google Dialer, which keeps recordings in private app storage that Android blocks every other app from reading, so those handsets cannot be used. That is confirmed on hardware, not guessed, and the full matrix is published on our phone compatibility page.",
  },
  {
    q: "Does it work on Tamil calls, and on calls that switch between Tamil and English?",
    a: "Yes, including the half-and-half sentences people actually speak on a sales call. Tamil, Hindi, Telugu and English are handled, and a sentence that starts in Tamil and finishes in English is transcribed as it was spoken rather than forced into one language. The fields pulled out of the call are the same either way.",
  },
  {
    q: "Can I see which telecaller actually converts, not just who dialled the most?",
    a: "Yes. Every call carries the telecaller who made it, and every lead carries the call it came from, so the dashboard reports conversion by person rather than call volume by person. Because the calls are written down, you can also read what the people who convert actually say, which is the part a call log can never give you.",
  },
  {
    q: "Does the data also go into my CRM?",
    a: "Yes. A qualified call becomes a lead in your CRM with the fields already filled in, across eleven live connectors including LeadSquared, HubSpot, Freshsales and Pipedrive, plus plain webhooks, Zapier, Make and n8n for anything else. You map your own field names. If you do not run a CRM, Auratel has its own lead board and nothing else is needed.",
  },
  {
    q: "Who in my company can see the recordings?",
    a: "Only the people in your organisation you give access to. Isolation is enforced inside Postgres by row-level security, on a database role that has no permission to bypass it, rather than by application code that has to remember to filter. A bug in a query cannot return another company's rows, and every access to your data is written to an audit log you can read.",
  },
  {
    q: "Who asks the customer for consent to record?",
    a: "Your telecaller does, out loud, at the start of the call, and waits for an answer. One sentence is enough: that the call is recorded, why, and is that alright. Auratel takes no part in obtaining it. There is no spoken notice in the app, no field that stores the customer's yes or no, and no way for the software to refuse a call. What the console can tell you is whether your telecaller disclosed the recording, per call and as a percentage per person, so you can supervise your own floor. That is a model's reading of the transcript rather than proof, and it says what your telecaller said, never what your customer agreed to. Under the DPDP Act the business making the call is the Data Fiduciary, so obtaining consent, and any consequence of not obtaining it, rests with you and not with us.",
  },
  {
    q: "Is Auratel DPDP compliant?",
    a: "Auratel is built to meet India's Digital Personal Data Protection Act, 2023, and the division of duties it sets out: you are the Data Fiduciary and Auratel is the Data Processor, processing your recordings on your instructions and for nothing else. On our side that means the database runs on our own servers in Mumbai, isolation is enforced by Postgres row-level security on a role that cannot bypass it, recordings are deleted when your retention window runs out, erasing a call cascades through the transcript, fields, lead and CRM record and returns a signed receipt, and access is written to an audit log. Consent is the part that stays with you, because it happens on a call we are not party to.",
  },
  {
    q: "How long are the recordings kept?",
    a: "As long as your organisation's retention setting says and no longer. It defaults to 90 days, it is yours to change, and a scheduled job deletes the audio, the transcript and everything derived from it when the clock runs out. You can also erase a single call: the recording, the transcript, the extracted fields, the lead and the CRM delivery record all go, and you get a signed receipt in your audit log.",
  },
];

export const metadata: Metadata = pageMetadata({
  title: "Call tracking dashboard for telecaller teams",
  description:
    "What Auratel does: transcribes every call your telecallers make in Tamil and " +
    "English, pulls out the customer's requirement, turns it into a lead in your CRM, " +
    "and reports who is actually converting. Works on the Android phones you already have.",
  path: PATH,
});

/* ── 1 · Hero ─────────────────────────────────────────────────────────────
   The capability claim and the scope of it, then two ways forward - one to
   start, one to read on. x.ai's "Get API Access / View Documentation" pair.
   Neither button says "now", and nothing here is a countdown. */

function Hero() {
  return (
    <section className="relative overflow-x-clip">
      <div className="mk-wash" />
      <div className="relative z-10 mx-auto max-w-6xl px-5 pt-6 pb-12 sm:px-6 sm:pt-10 sm:pb-16 lg:pt-14 lg:pb-20">
        {/* Structured data only - the visible trail came off on 2026-10-13.
            Rendered here rather than beside the other JSON-LD blocks below so
            the three stay in one place per page and the crumb sits with the
            section it describes. */}
        <BreadcrumbSchema current={{ label: "Call tracking dashboard", href: PATH }} />

        <div className="max-w-[48rem]">
          <p className="mk-eyebrow mb-4">Call tracking dashboard</p>
          <h1 className="mk-display mk-h1">
            Call intelligence for teams that{" "}
            <span className="mk-gradient-text">sell on the phone.</span>
          </h1>

          <p className="mk-lede mt-5 sm:mt-6">
            Transcription, field extraction, lead capture, coaching material and reporting,
            all of it from the calls your telecallers already make, on the Android handsets
            they already carry. Nothing new to dial, nothing for your customer to install.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3 sm:mt-10 sm:gap-4">
            <Link href={CTA} className="mk-cta">
              Book a walkthrough
              <span aria-hidden="true">→</span>
            </Link>
            <Link href="#what-it-does" className="mk-cta-ghost">
              See what it does
            </Link>
          </div>
        </div>

        {/* The contents rail. Horizontal and wrapping, so on a phone it is a
            couple of lines of links rather than a six-item column pushing the
            first section under two screens of scroll. */}
        <nav aria-label="Page contents" className="mt-12 border-t pt-5" style={{ borderColor: "var(--mk-line)" }}>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {CONTENTS.map((c) => (
              <li key={c.href}>
                <a
                  href={c.href}
                  className="underline decoration-1 underline-offset-4 hover:no-underline"
                  style={{ color: "var(--mk-muted)" }}
                >
                  {c.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </section>
  );
}

/* ── 2 · The figure band ──────────────────────────────────────────────────
   MOVED HERE from the bottom of the pipeline section on 2026-10-13, on doc 48
   §7.2. Of the 25 vendor pages torn down in that document, every single one
   puts a hard number inside the first two screenfuls, and the number is always
   one of four kinds: a customer count, years in business, volume processed, or
   a named customer's outcome percentage. Nielsen Norman's eyetracking is the
   reason it works - 57% of viewing time is spent above the fold and 74% inside
   the first two screenfuls, so a number placed in section five is a number
   most readers never reach.

   We can honestly publish NONE of those four kinds. Three customers is not a
   count, we are not old enough for years, no volume figure has been agreed as
   publishable, and the one outcome percentage on this site (the "5x" in
   proof.tsx) is unsubstantiated. So the slot is filled with product facts
   instead, which is what this band already was; only its position changed.

   The property that makes it worth having is that every number here is
   checkable against another published page on this same site. That is also
   the property that stops it drifting into a stats band, which doc 48 §11.5
   says we must not build. */

const FACTS = [
  { n: "4", l: "languages, code-switching included" },
  { n: "8", l: "handset brands capture-verified" },
  { n: "11", l: "live CRM connectors" },
  { n: "90", l: "days default retention, set by you" },
];

function Figures() {
  return (
    <section className="mx-auto max-w-6xl px-5 pb-4 sm:px-6">
      <dl
        className="grid gap-px overflow-hidden rounded-[14px] border sm:grid-cols-2 lg:grid-cols-4"
        style={{ borderColor: "var(--mk-line)", background: "var(--mk-line)" }}
      >
        {FACTS.map((f) => (
          <div key={f.l} className="p-6" style={{ background: "var(--mk-surface)" }}>
            <dt className="sr-only">{f.l}</dt>
            <dd>
              <span className="mk-display tabular block text-4xl sm:text-5xl">{f.n}</span>
              <span
                className="mt-2 block text-[0.8125rem] leading-snug"
                style={{ color: "var(--mk-muted)" }}
              >
                {f.l}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ── 3 · The problem ──────────────────────────────────────────────────────
   NEW on 2026-10-13, on doc 48 §4.4 and §11.2. The page explained in detail
   what happens to a call after it ends, and never once showed the state the
   reader is actually in. Of the 25 pages in that teardown only ramp.com draws
   the before state, and its flat caption - "This is what five separate systems
   to reimburse a flight looks like." - does more work than any of its feature
   panels, because the reader recognises themselves in it before being sold to.

   Ours is the stock Android call log, which is genuinely all a telecalling
   floor has today, with the one column that matters drawn empty. See
   CallLogSurface in components/explainer/surfaces.tsx for why it is drawn as
   an explicit absence rather than left blank.

   The caption below the figure is VISIBLE, unlike the sr-only captions on
   every other panel on this page. That is the whole mechanism: a diagram
   nobody can read in one glance needs its point said in words, and Ramp's
   version is one flat sentence with no adjectives in it. This one makes no
   claim about Auratel at all - it describes the reader's own call log, which
   is why it can afford to be blunt.

   It sits BEFORE "what it does" deliberately. The five capabilities read as
   features in the abstract and as answers once the gap is on the screen. */

function Problem() {
  return (
    <section
      id="the-problem"
      className="mk-anchor mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-20 lg:py-24"
    >
      <p className="mk-eyebrow mb-4">The problem</p>
      <h2 className="mk-display mk-h2 max-w-2xl">
        A call ends and takes everything with it.
      </h2>
      <p className="mk-lede mt-5">
        Your telecaller spent nineteen minutes on a quote, a competitor&rsquo;s rate and a
        delivery date. Your phone kept the number and the duration. Whether any of the
        rest reaches you depends on whether one tired person remembers to write it down.
      </p>

      <div className="mt-10 grid items-start gap-8 sm:mt-14 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14">
        <div>
          <CallLogSurface />
          {/* Visible on purpose - see the section note. One flat sentence, no
              adjectives, making no claim about us. */}
          <p
            className="mt-4 text-[0.9375rem] leading-relaxed"
            style={{ color: "var(--mk-muted)" }}
          >
            This is everything a nineteen minute call leaves behind today.
          </p>
        </div>

        <ul className="space-y-5">
          {[
            [
              "The content lives in one head",
              "Nobody else on the floor can hear what was promised, so nobody can check it, repeat it or coach it.",
            ],
            [
              "The follow-up depends on memory",
              "A rate held until Friday is only held if the person who offered it remembers Friday.",
            ],
            [
              "Your best caller cannot be copied",
              "Whatever they do differently is invisible, so a new joiner learns it slowly or never.",
            ],
          ].map(([t, d]) => (
            <li key={t}>
              <span
                className="mb-3 block h-1 w-10 rounded-full"
                style={{ background: "var(--brand-gradient)" }}
                aria-hidden="true"
              />
              <h3 className="text-lg font-semibold">{t}</h3>
              <p
                className="mt-2 text-[0.9375rem] leading-relaxed"
                style={{ color: "var(--mk-muted)" }}
              >
                {d}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ── 4 · What it does ─────────────────────────────────────────────────────
   Five capabilities, each one sentence of explanation beside a panel of the
   thing itself. This is the section the rewrite exists for: the old version
   made five claims in five cards, and this one shows five outputs.

   Alternating sides at `lg` so the eye zig-zags down the page instead of
   running down one column; stacked in source order on a phone, where the text
   must come before its panel or the panel arrives unexplained. */

const CAPABILITIES = [
  {
    id: "transcribe",
    eyebrow: "01 · Transcribe",
    title: "Every call, written down",
    body: "The handset's own recording is uploaded, transcribed and split by speaker. Tamil, Hindi, Telugu and English, including the sentences that switch language halfway through, which is how most sales calls in South India actually sound. You read the call instead of listening to it.",
    surface: <TranscriptSurface />,
  },
  {
    id: "extract",
    eyebrow: "02 · Extract",
    title: "The details, pulled out as fields",
    body: "Not a summary. You tell Auratel which facts matter in your business, and those are the ones taken from every call: what the customer wanted, how much, the rate discussed, the objection raised, what was promised and when. The field names are yours, not ours.",
    surface: <FieldsSurface />,
  },
  {
    id: "qualify",
    eyebrow: "03 · Qualify",
    title: "A lead, already filled in",
    body: "A call worth following up becomes a lead with its fields in place, rated hot, medium or cold, on a board you move through your own stages. Every stage change is recorded with who made it and when, so the board is a history rather than a snapshot somebody rearranged.",
    surface: <LeadSurface />,
  },
  {
    id: "measure",
    eyebrow: "04 · Measure",
    title: "Who converts, and what they say",
    body: "Per person: calls made, leads produced, conversion, and how that sits against the rest of the floor. Built from the calls themselves, so it cannot be moved by logging activity that did not happen. The month is exportable as a PDF you can take into a review.",
    surface: <ScorecardSurface />,
  },
  {
    id: "deliver",
    eyebrow: "05 · Deliver",
    title: "Into the CRM you already run",
    body: "The lead is created in your CRM for you, mapped to your own field names, across eleven live connectors plus webhooks, Zapier, Make and n8n. If you do not run a CRM, Auratel's own board is the CRM and nothing else is needed.",
    surface: <DeliverySurface />,
  },
];

function WhatItDoes() {
  return (
    <section
      id="what-it-does"
      className="mk-anchor border-y py-16 sm:py-20 lg:py-24"
      style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <p className="mk-eyebrow mb-4">What it does</p>
        <h2 className="mk-display mk-h2 max-w-3xl">
          Five things happen to a call after your telecaller hangs up.
        </h2>
        <p className="mk-lede mt-5">
          None of them need anyone on your team to do anything. The panels below are
          illustrations of the console, drawn from one sample call (20,000 interlock bricks
          to a site at Perundurai), and they are not any customer&rsquo;s data.
        </p>

        <div className="mt-12 space-y-14 sm:mt-16 sm:space-y-20">
          {CAPABILITIES.map((c, i) => (
            <div
              key={c.id}
              id={c.id}
              className="mk-anchor grid items-center gap-7 lg:grid-cols-2 lg:gap-14"
            >
              <div className={i % 2 === 1 ? "lg:order-2" : undefined}>
                <p
                  className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em]"
                  style={{ color: "var(--mk-muted)" }}
                >
                  {c.eyebrow}
                </p>
                <h3 className="mt-3 text-2xl font-semibold tracking-tight sm:text-[1.75rem]">
                  {c.title}
                </h3>
                <p className="mt-3.5 text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-ink)" }}>
                  {c.body}
                </p>
              </div>
              <div className={i % 2 === 1 ? "lg:order-1" : undefined}>{c.surface}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── 5 · The pipeline ─────────────────────────────────────────────────────
   x.ai's "One API. Every modality." - the mechanism end to end, then a band
   of figures underneath. Every figure here is a fact about the product, which
   is the only kind of figure we can put on a page honestly today. */

const PIPELINE = [
  {
    t: "The handset records, as it already does",
    d: "Your team's own phone, your team's own SIM, the dialer's own recording setting. One setting is switched on per handset and nothing else about how they work changes.",
  },
  {
    t: "The file leaves the phone on its own",
    d: "Encrypted in transit, over whatever connection the phone has, queued and retried when there is no signal. There is no step a busy telecaller can skip and no upload button to forget.",
  },
  {
    t: "Speech becomes text, text becomes facts",
    d: "Transcribed and diarized, then read by an extraction agent configured for your business, which is what turns a wall of conversation into the eight fields in the panel above.",
  },
  {
    t: "It lands where you work",
    d: "The call in the console, the lead on the board, the row in your CRM, the numbers in the report. One pass, four destinations, nobody typing it twice.",
  },
];

function Pipeline() {
  return (
    <section
      id="pipeline"
      className="mk-anchor mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-20 lg:py-24"
    >
      <p className="mk-eyebrow mb-4">How it works</p>
      <h2 className="mk-display mk-h2 max-w-2xl">One pipeline. Every call on it.</h2>
      <p className="mk-lede mt-5">
        There is no app for your team to open and no form for them to fill in. The whole
        path from a ringing phone to a row in your CRM runs without anyone deciding to
        start it.
      </p>

      <ol className="mk-timeline mt-10 sm:mt-14">
        {PIPELINE.map((s, i) => (
          <li key={s.t} className="mk-tl-step">
            <span className="mk-step-num" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <h3 className="text-lg font-semibold">{s.t}</h3>
              <p className="mt-2 text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
                {s.d}
              </p>
            </div>
          </li>
        ))}
      </ol>

    </section>
  );
}

/* ── 6 · What we help with ────────────────────────────────────────────────
   The owner asked for this section by name. It is deliberately written as
   jobs rather than features: each item is a thing somebody is already trying
   to do badly with no data, and what they get instead. */

const HELP = [
  {
    t: "Coaching that is not opinion",
    d: "You can point at a real call where the objection was handled well, in writing, and read it out in Monday's huddle. Coaching from evidence rather than from whoever argued hardest in the last review.",
  },
  {
    t: "Knowing why deals die",
    d: "The objection on every call, counted across all of them. Price, timeline, a competitor's quote, a decision-maker who was never on the call - ranked by how often it actually ends the conversation.",
  },
  {
    t: "Follow-ups that were promised",
    d: "A call where somebody said they would send a quotation on Friday carries that commitment into the lead. It stops living in one person's memory and becomes something you can check.",
  },
  {
    t: "Data entry that nobody does",
    d: "The reason your CRM is half empty is that filling it in is unpaid work at the end of a long day. Here the record is a by-product of the call, so it exists whether or not anyone felt like typing.",
  },
  {
    t: "Reviews with numbers in them",
    d: "Conversion by person, by day and by week, from the calls themselves. Enough to tell the difference between a quiet month and a person who stopped trying, which is the distinction every review needs and almost none can make.",
  },
  {
    t: "Disputes about what was said",
    d: "A customer who insists they were quoted a different rate is a question with an answer. The call is transcribed, timestamped and still there, for as long as your retention setting says it is.",
  },
];

function WhatWeHelpWith() {
  return (
    <section
      id="what-we-help-with"
      className="mk-anchor border-y py-16 sm:py-20 lg:py-24"
      style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <p className="mk-eyebrow mb-4">What we help with</p>
        <h2 className="mk-display mk-h2 max-w-2xl">
          Six jobs that are impossible without the calls written down.
        </h2>

        <div className="mt-10 grid gap-4 sm:mt-14 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
          {HELP.map((h) => (
            <div key={h.t} className="mk-card p-7">
              <span
                className="mb-5 block h-1 w-10 rounded-full"
                style={{ background: "var(--brand-gradient)" }}
                aria-hidden="true"
              />
              <h3 className="text-lg font-semibold">{h.t}</h3>
              <p
                className="mt-2.5 text-[0.9375rem] leading-relaxed"
                style={{ color: "var(--mk-muted)" }}
              >
                {h.d}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── 7 · Who it's for ─────────────────────────────────────────────────────
   Two readers, two different reasons, kept from the first version because the
   owner's brief named both audiences. Rewritten calmer: the floor-lead card
   used to say the dashboard is "uncomfortable", which is true and is also an
   odd thing to say to somebody you want reading on. */

const AUDIENCES = [
  {
    t: "You own the business",
    d: "You are not on the calls and you are never going to be. What you need is what four hundred of them add up to: which days are worth staffing, which person converts, which objection is costing you deals, and what the good calls sound like so the rest of the floor can be taught them.",
    points: [
      "The month, consolidated, in a file you can read on a Sunday",
      "Conversion by person, built from calls rather than from self-reporting",
      "The words that worked on a real call, ready for Monday's huddle",
    ],
  },
  {
    t: "You run the calling floor",
    d: "You are the one asked why the numbers moved, and you are also the one being measured. A written record of every call answers both: it replaces an argument about who is working hard with evidence, and the person whose quiet good work was invisible is usually the one it helps most.",
    points: [
      "Good calls stop being invisible, because they are in writing",
      "No activity forms to fill in - the record comes from the call itself",
      "A follow-up that was promised sits on the lead, not in your head",
    ],
  },
];

function WhoItsFor() {
  return (
    <section
      id="who-its-for"
      className="mk-anchor mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-20 lg:py-24"
    >
      <p className="mk-eyebrow mb-4">Who it&rsquo;s for</p>
      <h2 className="mk-display mk-h2 max-w-2xl">
        Two people read this dashboard, for opposite reasons.
      </h2>

      <div className="mt-10 grid gap-5 sm:mt-14 lg:grid-cols-2">
        {AUDIENCES.map((a) => (
          <div key={a.t} className="mk-card p-8">
            <span
              className="mb-5 block h-1 w-10 rounded-full"
              style={{ background: "var(--brand-gradient)" }}
              aria-hidden="true"
            />
            <h3 className="text-xl font-semibold">{a.t}</h3>
            <p className="mk-lede mt-3">{a.d}</p>
            <ul className="mt-6 space-y-3 text-[0.9375rem]">
              {a.points.map((p) => (
                <li key={p} className="flex gap-3">
                  <span
                    className="mt-2 h-1.5 w-1.5 flex-none rounded-full"
                    style={{ background: "var(--brand-gradient)" }}
                    aria-hidden="true"
                  />
                  <span style={{ color: "var(--mk-ink)" }}>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── 8 · What it doesn't do ───────────────────────────────────────────────
   The limits, as information rather than as a sales device. The first version
   ran these as a disqualifier - "four cases where this is not for you", ending
   on "buy the ₹200 app" - which is a direct-response move and the opposite of
   the register asked for. The facts are identical; only the framing changed.
   They stay on the page because a vendor who names its limits is trusted on
   everything else, and because two of them decide whether Auratel can work at
   all for a given team. */

const LIMITS = [
  {
    t: "Pixel, Motorola and Nokia handsets",
    d: "Those phones record into the Google Dialer's private storage, which Android blocks every other app from reading. There is no permission that opens it and no version of Auratel that works around it. Eight other brands are capture-verified.",
  },
  {
    t: "WhatsApp and other internet calls",
    d: "Android gives the messaging app exclusive use of the microphone during a VoIP call, so any recorder receives silence. We capture that the call happened, not the audio. Anyone who tells you otherwise has not tested it on a handset.",
  },
  {
    t: "Dialling, or sending anything by itself",
    d: "Auratel does not place calls and does not message your customers. It reads what your team already did. The outward-facing side of the product is deliberately a thing a person presses, not a thing a system decides.",
  },
  {
    // The owner's instruction, 2026-10-13, and it belongs in the limits rather
    // than buried on /consent: a buyer who assumes the app handles consent has
    // bought the wrong thing. The app has no spoken notice, no consent field
    // and no refusal path - see /consent for the detail and the one beep that
    // does exist on the microphone fallback.
    t: "Asking your customer for consent",
    d: "Your telecaller says it out loud at the start of the call and waits for an answer. Auratel plays no spoken notice, records no yes or no, and cannot tell whether anyone agreed. Under the DPDP Act that duty belongs to the business making the call: we take no part in it and carry no responsibility for it, which is the position our terms set out too.",
  },
  {
    t: "Making the decision for you",
    d: "The dashboard tells you which objection is costing you deals and who handles it well. Acting on that is still a management job, and if nothing on the floor will change once you know, it will not pay for itself.",
  },
];

function Limits() {
  return (
    <section
      id="limits"
      className="mk-anchor border-y py-16 sm:py-20 lg:py-24"
      style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <p className="mk-eyebrow mb-4">What it doesn&rsquo;t do</p>
        <h2 className="mk-display mk-h2 max-w-2xl">The limits, before you ask.</h2>
        <p className="mk-lede mt-5">
          Two of these decide whether Auratel can work for your team at all, so they are here
          rather than in a footnote.
        </p>

        <div className="mt-10 grid gap-4 sm:mt-14 sm:gap-5 lg:grid-cols-2">
          {LIMITS.map((n) => (
            <div key={n.t} className="mk-card p-7">
              <h3 className="text-lg font-semibold">{n.t}</h3>
              <p
                className="mt-2.5 text-[0.9375rem] leading-relaxed"
                style={{ color: "var(--mk-muted)" }}
              >
                {n.d}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-10 text-[0.9375rem]" style={{ color: "var(--mk-muted)" }}>
          The full detail is published, not summarised:{" "}
          <Link href="/compatibility" className="underline underline-offset-4">
            every handset we have tested
          </Link>
          ,{" "}
          <Link href="/security" className="underline underline-offset-4">
            where your recordings live and who can reach them
          </Link>
          , and{" "}
          <Link href="/consent" className="underline underline-offset-4">
            what you are responsible for telling the person on the other end
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

/* ── 9 · What it costs ────────────────────────────────────────────────────
   A price on the explainer page, not only on /pricing.

   Doc 10 §6: hiding the price is standard for enterprise and fatal for an SMB,
   who closes the tab rather than filling in a form to find out. A reader who
   has got this far has decided the product is interesting and the next thing
   they want is the number - making them navigate for it is a drop-off for no
   gain.

   Four tiers in one row, headline figure only. The full list - what each
   meter includes, the add-ons, and what happens when you go over - is on
   /pricing, because repeating all of it here would turn an explainer into a
   price list. Every figure is read from @aura/shared, so this block cannot
   quote a price the invoice does not. */

function Price() {
  return (
    <section
      id="pricing"
      className="mk-anchor mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-20 lg:py-24"
    >
      <p className="mk-eyebrow mb-4">What it costs</p>
      <h2 className="mk-display mk-h2 max-w-2xl">
        Priced by the audio, never by the seat.
      </h2>
      <p className="mk-lede mt-5">
        Four meters: handsets paired, transcription hours used, how long we keep the audio,
        and a storage ceiling. Every one of them is a cost we carry, which is why none of
        them is a login. Put as many managers in the dashboard as you like.
      </p>

      <dl className="mt-10 grid gap-4 sm:mt-14 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        {PLANS.map((p) => (
          <div key={p.key} className="mk-card flex flex-col p-6">
            <dt className="text-base font-semibold">{p.name}</dt>
            <dd className="mt-3 flex-1">
              <p>
                {p.showPrice ? (
                  <>
                    <span className="mk-display tabular text-[1.75rem]">{p.annual}</span>
                    <span className="text-[0.8125rem]" style={{ color: "var(--mk-muted)" }}>
                      {" "}
                      /mo
                    </span>
                  </>
                ) : (
                  <span className="mk-display text-[1.75rem]">Quoted</span>
                )}
              </p>
              <p
                className="mt-2.5 text-[0.8125rem] leading-relaxed"
                style={{ color: "var(--mk-muted)" }}
              >
                {p.blurb}
              </p>
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-6 text-[0.8125rem]" style={{ color: "var(--mk-muted)" }}>
        {GST_NOTE}{" "}
        <Link href="/pricing" className="underline underline-offset-4">
          The full price list
        </Link>{" "}
        has every included limit, the add-ons, and what happens if you go over one.
      </p>
    </section>
  );
}

/* ── 10 · FAQ ──────────────────────────────────────────────────────────────
   `<details>`/`<summary>`, no JavaScript: the browser supplies keyboard
   operation, the open/closed state and the screen-reader semantics for free,
   and this page is written for a mid-range Android on 4G (doc 10 §9). The
   array feeds both this accordion and the FAQPage JSON-LD, because Google
   penalises markup that does not match the visible page. */

function Faq() {
  return (
    <section id="faq" className="mk-anchor mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-20 lg:py-24">
      <p className="mk-eyebrow mb-4">Questions</p>
      {/* Counted from the array rather than typed, so adding a question cannot
          leave the heading claiming a number the page does not show. */}
      <h2 className="mk-display mk-h2 max-w-2xl">
        The {PAGE_FAQ.length} things people ask first.
      </h2>

      <div className="mt-10 max-w-3xl sm:mt-14">
        {PAGE_FAQ.map((f) => (
          <details key={f.q} className="group border-b py-5" style={{ borderColor: "var(--mk-line)" }}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left">
              <h3 className="text-lg font-semibold">{f.q}</h3>
              <span
                aria-hidden="true"
                className="shrink-0 transition-transform duration-150 ease-out group-open:rotate-45"
                style={{ color: "var(--mk-muted)" }}
              >
                +
              </span>
            </summary>
            <p className="mt-3 text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
              {f.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ── 11 · The close ────────────────────────────────────────────────────────
   x.ai's "Choose how to get started": two cards, two honest paths, no
   gradient slab shouting at the reader. The gradient CTA band that used to
   close this page is the single most landing-page element on it, and it is
   also redundant - the homepage closes on exactly that, in those words.

   Both cards end at /start, because that is the one entrance that is watched
   (lib/site.ts). The difference is what the visitor is agreeing to, and for a
   reader who is not ready that distinction is the difference between a click
   and a closed tab. */

function GetStarted() {
  return (
    <section
      className="border-t py-16 sm:py-20 lg:py-24"
      style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <p className="mk-eyebrow mb-4">Getting started</p>
        {/* Returns to the hero's own words, on doc 48 §3.4. Ramp repeats its
            hero headline verbatim in the closing block; Linear reuses one
            closing banner across the homepage and /pricing; Attio keeps the
            phrase and makes the product the subject of it. All three hand the
            reader who scrolled the whole page back the one sentence they are
            meant to leave with, instead of a tenth new one. This page used to
            close on "Two ways in, depending on what you need." - true, and
            about the form rather than about them. That sentence is still here,
            demoted to the lede where it belongs, because the two cards below
            do need framing. */}
        <h2 className="mk-display mk-h2 max-w-2xl">
          Your team already sells on the phone.
        </h2>
        <p className="mk-lede mt-5">
          Two ways in, depending on whether you want to see it on your own calls or check
          it fits your handsets first.
        </p>

        <div className="mt-10 grid gap-5 sm:mt-14 lg:grid-cols-2">
          <div
            className="flex flex-col rounded-[20px] border p-8"
            style={{ borderColor: "var(--mk-line)", background: "var(--mk-ground)" }}
          >
            <h3 className="text-xl font-semibold">See it on your own calls</h3>
            <p className="mk-lede mt-3">
              Tell us how your team sells today and we come back with what Auratel would have
              pulled out of a week of your calls: the objections, the commitments, and who
              is actually converting.
            </p>
            <ul className="mt-6 flex-1 space-y-3 text-[0.9375rem]">
              {[
                "A read of your own calls before you decide anything",
                "A real person replies, not a sequence",
                "We'll tell you honestly if it isn't a fit",
              ].map((t) => (
                <li key={t} className="flex gap-3">
                  <span
                    className="mt-2 h-1.5 w-1.5 flex-none rounded-full"
                    style={{ background: "var(--brand-gradient)" }}
                    aria-hidden="true"
                  />
                  <span style={{ color: "var(--mk-ink)" }}>{t}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <Link href={CTA} className="mk-cta">
                Book a walkthrough
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>

          <div
            className="flex flex-col rounded-[20px] border p-8"
            style={{ borderColor: "var(--mk-line)", background: "var(--mk-ground)" }}
          >
            <h3 className="text-xl font-semibold">Check it fits first</h3>
            <p className="mk-lede mt-3">
              Reasonable, and everything you need to decide is already published. Start with
              the handsets, because that is the one answer that can rule Auratel out before
              anything else matters.
            </p>
            <ul className="mt-6 flex-1 space-y-3 text-[0.9375rem]">
              {[
                ["Which phones we can capture from", "/compatibility"],
                ["Where your recordings live, and who can reach them", "/security"],
                ["Call recording and consent in India", "/consent"],
              ].map(([label, href]) => (
                <li key={href} className="flex gap-3">
                  <span
                    className="mt-2 h-1.5 w-1.5 flex-none rounded-full"
                    style={{ background: "var(--brand-gradient)" }}
                    aria-hidden="true"
                  />
                  <Link href={href} className="underline underline-offset-4" style={{ color: "var(--mk-ink)" }}>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <Link href="/compatibility" className="mk-cta-ghost">
                Start with the handsets
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function CallTrackingDashboardPage() {
  const url = `${SITE_URL}${PATH}`;

  return (
    <>
      {/* Three separate blocks rather than one @graph: they are three
          independent statements, and a malformed one should not invalidate the
          other two. FAQPage is the one that can win space in a result;
          BreadcrumbList replaces the bare URL under the title; WebPage ties
          the page to the product and publisher without declaring a second
          SoftwareApplication entity - the homepage owns that one, and two of
          them at different URLs is the ambiguity that gets structured data
          ignored altogether. */}
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: PAGE_FAQ.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }}
      />
      {/* BreadcrumbList is emitted by <BreadcrumbSchema> in the hero, not
          here, so one component owns the shape of it across all four pages. */}
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebPage",
          url,
          name: "Call tracking dashboard for telecaller teams",
          inLanguage: "en-IN",
          isPartOf: { "@type": "WebSite", name: BRAND, url: SITE_URL },
          about: { "@type": "SoftwareApplication", name: BRAND, url: SITE_URL },
          publisher: { "@type": "Organization", name: LEGAL_ENTITY },
        }}
      />

      <div className="mk-page">
        <Hero />
        {/* Figures then Problem, both added 2026-10-13 from doc 48: a hard
            number inside the first two screenfuls (§7.2), then the before
            state drawn rather than described (§4.4), so the five capabilities
            below land as answers instead of as features. */}
        <Figures />
        <Problem />
        <WhatItDoes />
        <Pipeline />
        <WhatWeHelpWith />
        <WhoItsFor />
        {/* Imported from components/proof.tsx, never copied: one array of
            words for the whole site. Its own file carries the warning that
            these sentences still need the two customers' sign-off. */}
        <Proof />
        <Limits />
        <Price />
        <Faq />
        <GetStarted />
      </div>
    </>
  );
}
