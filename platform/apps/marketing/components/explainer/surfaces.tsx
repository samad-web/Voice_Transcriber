/**
 * Console surfaces, drawn in HTML.
 *
 * ── WHY THESE EXIST ───────────────────────────────────────────────────────
 *
 * The explainer page's job is to show what Auratel does, not to assert it. x.ai
 * (fetched 2026-10-13, which is where this page's register comes from) makes
 * every product claim by putting a working-looking panel of that product next
 * to one sentence about it - a chat exchange, an agent run with tool calls, a
 * file being edited. The sentence states the capability; the panel is the
 * evidence. That is the pattern copied here. What is NOT copied is their
 * visual identity: these panels are built from the Auratel marketing tokens
 * (--mk-*) and the brand gradient, because doc 10 §7 is explicit that a
 * marketing site which looks like the product is a trust signal.
 *
 * ── WHY HTML AND NOT SCREENSHOTS ──────────────────────────────────────────
 *
 * Doc 10 §7 asks for real product screenshots and doc 10 §11 says never to
 * screenshot real customer data, which together require a seeded demo tenant
 * that does not exist yet. A hand-drawn mockup of a screen is the honest
 * middle: it illustrates the shape of the output without claiming to be a
 * photograph of anyone's console. When the demo tenant exists these should be
 * replaced by captures of it - the layouts below deliberately mirror the real
 * screens so that swap is a like-for-like.
 *
 * They also cost nothing. No image bytes, no layout shift, no JS, and they
 * re-colour themselves in dark mode, which a raster cannot (the hero card
 * needs six files for exactly that reason - see components/landing.tsx).
 *
 * ── THE FIXTURE ───────────────────────────────────────────────────────────
 *
 * One sample call, used across every panel: 20,000 interlock bricks to a site
 * at Perundurai at ₹32 a unit. It is the same fixture the hero animation and
 * its alt text already publish, so the site tells one story rather than five.
 * It is a scenario attributed to nobody - doc 10 §15 bans invented numbers
 * presented as PROOF, and none of these are presented as proof: the section
 * that renders them says in visible copy that they are illustrations.
 *
 * ── ACCESSIBILITY ─────────────────────────────────────────────────────────
 *
 * Each panel is a <figure> with an sr-only <figcaption> that states what the
 * panel shows, because for anyone who cannot see it the panel IS the argument
 * - the same reasoning as the hero image's long alt text. The decorative bits
 * (the window dots, the gradient rules) are aria-hidden.
 */

const FRAME =
  "overflow-hidden rounded-[14px] border text-left";

/** The shared panel chrome: a title strip, then the content. */
function Surface({
  label,
  caption,
  children,
}: {
  /** The screen this panel is standing in for, as the console names it. */
  label: string;
  /** Read instead of the panel by a screen reader. Describe, don't label. */
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <figure
      className={FRAME}
      style={{ borderColor: "var(--mk-line)", background: "var(--mk-ground)" }}
    >
      <div
        className="flex items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 flex-none rounded-full"
          style={{ background: "var(--brand-gradient)" }}
        />
        <span
          className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em]"
          style={{ color: "var(--mk-muted)" }}
        >
          {label}
        </span>
      </div>
      <div className="p-4 sm:p-5">{children}</div>
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}

/* ── 0 · The before state ─────────────────────────────────────────────────
   Every other panel in this file draws an Auratel screen. This one draws what
   the customer has WITHOUT us, and it is the only panel here that is not a
   product claim at all.

   It exists because of doc 48 §4.4. Of the 25 vendor pages torn down there,
   exactly one (ramp.com) draws the problem rather than describing it: a
   deliberately tangled diagram of five finance systems, captioned in flat
   language - "This is what five separate systems to reimburse a flight looks
   like." It lands harder than any of its feature panels, because the reader
   recognises their own situation in it before being sold anything.

   Our equivalent is the stock Android call log, which is genuinely all a
   telecalling floor has today. The table is drawn complete and correct in
   three columns and empty in the fourth, because that is the honest shape of
   the problem: the metadata survives, the conversation does not. The empty
   column is the argument, so it is drawn as an explicit absence rather than
   left blank - a blank cell reads as a rendering fault, a dashed rule reads as
   a thing that is missing.

   Numbers are masked mid-digit the way the console masks them, and no row is
   attributed to anybody. The durations are ordinary: one long enquiry, one
   short brush-off, a missed call, one incoming. Nothing here is a statistic
   and nothing is presented as proof. */

const LOG: Array<{ num: string; dir: "Outgoing" | "Incoming" | "Missed"; len: string }> = [
  { num: "+91 94••• ••921", dir: "Outgoing", len: "18:42" },
  { num: "+91 98••• ••307", dir: "Outgoing", len: "04:15" },
  { num: "+91 73••• ••455", dir: "Missed", len: "--" },
  { num: "+91 90••• ••188", dir: "Incoming", len: "11:07" },
];

export function CallLogSurface() {
  return (
    <Surface
      label="Handset call log"
      caption="The stock call log on a telecaller's Android phone, as a four column table. Three columns are filled in: a masked phone number, whether the call was outgoing, incoming or missed, and its length in minutes - eighteen forty-two, four fifteen, no length for the missed call, eleven oh seven. The fourth column is headed 'What was said' and every cell in it is empty, drawn as a dashed line, because nothing on the handset records it."
    >
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {["Number", "Direction", "Length", "What was said"].map((h) => (
              <th
                key={h}
                scope="col"
                className="border-b pb-2 text-[0.625rem] font-semibold uppercase tracking-[0.12em]"
                style={{ borderColor: "var(--mk-line)", color: "var(--mk-muted)" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {LOG.map((r) => (
            <tr key={r.num}>
              <td
                className="tabular border-b py-2.5 pr-3 text-[0.8125rem] whitespace-nowrap"
                style={{ borderColor: "var(--mk-line)", color: "var(--mk-ink)" }}
              >
                {r.num}
              </td>
              <td
                className="border-b py-2.5 pr-3 text-[0.8125rem]"
                style={{ borderColor: "var(--mk-line)", color: "var(--mk-muted)" }}
              >
                {r.dir}
              </td>
              <td
                className="tabular border-b py-2.5 pr-3 text-[0.8125rem]"
                style={{ borderColor: "var(--mk-line)", color: "var(--mk-muted)" }}
              >
                {r.len}
              </td>
              {/* The point of the whole panel. Drawn as a dashed rule so it
                  reads as deliberately absent rather than as a cell that
                  failed to load. */}
              <td className="border-b py-2.5" style={{ borderColor: "var(--mk-line)" }}>
                <span
                  aria-hidden="true"
                  className="block w-full border-t border-dashed"
                  style={{ borderColor: "var(--mk-line)", minWidth: "4rem" }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Surface>
  );
}

/* ── 1 · The transcript ───────────────────────────────────────────────────
   Diarized, and code-switched mid-sentence on purpose: that is the claim this
   panel is making, and a clean English-only transcript would quietly make a
   different and much weaker one. */

const TURNS: Array<{ who: "Agent" | "Customer"; lang: "TA" | "EN"; said: string }> = [
  { who: "Customer", lang: "TA", said: "20,000 bricks venum, Perundurai site-ku. Rate enna irukku?" },
  { who: "Agent", lang: "EN", said: "For that quantity it works out to ₹32 a unit, delivered." },
  { who: "Customer", lang: "TA", said: "Konjam jaasti. Vera edathula 30-ku kedaikuthu." },
  { who: "Agent", lang: "EN", said: "I can hold ₹32 if the advance comes in by Friday." },
];

export function TranscriptSurface() {
  return (
    <Surface
      label="Transcript"
      caption="A transcribed call, split by speaker. The customer asks in Tamil for a rate on 20,000 bricks for a site at Perundurai; the agent answers in English at ₹32 a unit; the customer says a competitor quotes ₹30; the agent offers to hold the rate against an advance by Friday. Each turn is tagged with the language it was spoken in."
    >
      <ul className="space-y-3.5">
        {TURNS.map((t, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex w-[4.5rem] flex-none flex-col gap-1 pt-0.5">
              <span
                className="text-[0.6875rem] font-semibold uppercase tracking-wider"
                style={{ color: t.who === "Agent" ? "var(--mk-ink)" : "var(--mk-muted)" }}
              >
                {t.who}
              </span>
              <span
                className="tabular inline-flex w-fit rounded px-1.5 py-0.5 text-[0.625rem] font-semibold"
                style={{ background: "var(--mk-surface)", color: "var(--mk-muted)" }}
              >
                {t.lang}
              </span>
            </span>
            <span
              className="text-[0.875rem] leading-relaxed"
              style={{ color: "var(--mk-ink)" }}
            >
              {t.said}
            </span>
          </li>
        ))}
      </ul>
    </Surface>
  );
}

/* ── 2 · The extracted fields ─────────────────────────────────────────────
   The point of this panel is the LEFT column, not the right: the field names
   are the customer's own, which is the difference between extraction and a
   summary. The copy beside it says so; this shows it. */

const FIELDS: Array<[string, string]> = [
  ["Product", "Interlock brick"],
  ["Quantity", "20,000 units"],
  ["Site", "Perundurai"],
  ["Rate quoted", "₹32 / unit"],
  ["Order value", "₹6,40,000"],
  ["Objection", "Competitor quoting ₹30"],
  ["Commitment", "Hold rate against advance"],
  ["Next step", "Advance by Friday"],
];

export function FieldsSurface() {
  return (
    <Surface
      label="Extracted fields"
      caption="The same call as a set of fields: product interlock brick, quantity 20,000 units, site Perundurai, rate quoted ₹32 per unit, order value ₹6,40,000, objection a competitor quoting ₹30, commitment to hold the rate against an advance, next step advance by Friday."
    >
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {FIELDS.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <dt
              className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em]"
              style={{ color: "var(--mk-muted)" }}
            >
              {k}
            </dt>
            <dd className="text-[0.875rem] font-medium" style={{ color: "var(--mk-ink)" }}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </Surface>
  );
}

/* ── 3 · The lead ─────────────────────────────────────────────────────────
   Carries the two things that make this a record rather than a note: the call
   it came from, and the stage history underneath it. */

export function LeadSurface() {
  return (
    <Surface
      label="Lead board"
      caption="The call as a lead card. Rated hot, at the quotation-sent stage, worth ₹6,40,000, sourced from a call rather than entered by hand, owned by the telecaller who made the call. Below it a history: created from a call, moved to contacted, then moved to quotation sent, each with who moved it."
    >
      <div
        className="rounded-[10px] border p-4"
        style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.9375rem] font-semibold" style={{ color: "var(--mk-ink)" }}>
            Perundurai site, 20,000 bricks
          </span>
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.625rem] font-bold uppercase tracking-wider"
            style={{ background: "var(--brand-gradient)", color: "#fff" }}
          >
            Hot
          </span>
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[0.75rem]">
          {[
            ["Stage", "Quotation sent"],
            ["Value", "₹6,40,000"],
            ["Source", "Call"],
            ["Owner", "Telecaller 2"],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-1.5">
              <dt style={{ color: "var(--mk-muted)" }}>{k}</dt>
              <dd className="font-medium" style={{ color: "var(--mk-ink)" }}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <ol className="mt-4 space-y-2.5">
        {[
          ["Created from call", "Telecaller 2"],
          ["Contacted", "Telecaller 2"],
          ["Quotation sent", "Telecaller 2"],
        ].map(([event, who], i, arr) => (
          <li key={event} className="flex items-start gap-3">
            <span className="relative flex flex-none flex-col items-center pt-1">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: "var(--brand-gradient)" }}
              />
              {i < arr.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="mt-1 w-px flex-1"
                  style={{ height: "1.1rem", background: "var(--mk-line)" }}
                />
              ) : null}
            </span>
            <span className="text-[0.8125rem]">
              <span className="font-medium" style={{ color: "var(--mk-ink)" }}>
                {event}
              </span>
              <span style={{ color: "var(--mk-muted)" }}> &middot; {who}</span>
            </span>
          </li>
        ))}
      </ol>
    </Surface>
  );
}

/* ── 4 · The scorecard ────────────────────────────────────────────────────
   Three columns, and the third is the only one that matters. Calls and leads
   are there to make the point that the first two columns do not rank the same
   way the third one does - which is the entire argument for the screen. */

const ROWS: Array<[string, string, string, string]> = [
  ["Telecaller 1", "214", "19", "8.9%"],
  ["Telecaller 2", "168", "31", "18.5%"],
  ["Telecaller 3", "203", "14", "6.9%"],
];

export function ScorecardSurface() {
  return (
    <Surface
      label="Telecaller performance"
      caption="A scorecard comparing three telecallers. The first made 214 calls and produced 19 leads, a 8.9 per cent conversion. The second made 168 calls, fewer than the others, but produced 31 leads at 18.5 per cent. The third made 203 calls for 14 leads at 6.9 per cent. The person who dialled the most is not the person who converted the most."
    >
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {["Person", "Calls", "Leads", "Conversion"].map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`pb-2.5 text-[0.6875rem] font-semibold uppercase tracking-[0.1em] ${
                  i === 0 ? "" : "text-right"
                }`}
                style={{ color: "var(--mk-muted)" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([who, calls, leads, conv], i) => (
            <tr
              key={who}
              className="border-t"
              style={{
                borderColor: "var(--mk-line)",
                /* Row 2 is the one the surrounding copy is about, so it is the
                   one the eye should land on. A weight change rather than a
                   fill: a highlighted row in a marketing illustration reads as
                   a selected row, which would imply an interaction. */
                fontWeight: i === 1 ? 600 : 400,
              }}
            >
              <th
                scope="row"
                className="py-2.5 text-[0.8125rem] font-[inherit]"
                style={{ color: "var(--mk-ink)" }}
              >
                {who}
              </th>
              {[calls, leads].map((n, j) => (
                <td
                  key={j}
                  className="tabular py-2.5 text-right text-[0.8125rem]"
                  style={{ color: "var(--mk-muted)" }}
                >
                  {n}
                </td>
              ))}
              <td
                className="tabular py-2.5 text-right text-[0.8125rem]"
                style={{ color: "var(--mk-ink)" }}
              >
                {conv}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Surface>
  );
}

/* ── 5 · Delivery ─────────────────────────────────────────────────────────
   Only connectors that are live are named. Zoho, Salesforce, monday.com and
   Dynamics are in the catalogue but OAuth-pending, and Zoho in particular is
   the CRM most of this market runs - naming it here would be the most
   damaging line on the site. */

export function DeliverySurface() {
  return (
    <Surface
      label="CRM delivery"
      caption="The lead being delivered outward. Four destinations are listed, each marked delivered: LeadSquared, HubSpot, Freshsales and a webhook. A note underneath reads that fields are mapped to your own names, and that Auratel's own lead board is used when there is no CRM."
    >
      <ul className="space-y-2.5">
        {["LeadSquared", "HubSpot", "Freshsales", "Your own webhook"].map((name) => (
          <li
            key={name}
            className="flex items-center justify-between gap-3 rounded-[10px] border px-3.5 py-2.5"
            style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
          >
            <span className="text-[0.8125rem] font-medium" style={{ color: "var(--mk-ink)" }}>
              {name}
            </span>
            <span
              className="inline-flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider"
              style={{ color: "var(--mk-muted)" }}
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: "var(--brand-gradient)" }}
              />
              Delivered
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3.5 text-[0.75rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
        Mapped to your own field names. Eleven connectors are live, plus Zapier, Make, n8n
        and plain webhooks. No CRM? The lead stays on Auratel&rsquo;s own board.
      </p>
    </Surface>
  );
}
