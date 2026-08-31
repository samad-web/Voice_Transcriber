/**
 * The call card - a live call becoming a CRM row, built in CSS.
 *
 * THE HOMEPAGE DOES NOT RENDER THIS. It ships the card as an animated image
 * (see components/landing.tsx), because the owner's machine has Windows
 * animation effects switched off, which makes Chromium report
 * prefers-reduced-motion: reduce and freeze any CSS animation.
 *
 * This component is the SOURCE that image is generated from. It lives here,
 * rendered by the dev-only route at /capture/hero-card, so that:
 *
 *   · the asset is regenerable from real product code rather than hand-drawn,
 *     and cannot drift into claiming something the product does not do;
 *   · editing the card means editing markup and re-running one script, not
 *     opening a raster editor.
 *
 * It was briefly deleted when the image landed, which broke regeneration in a
 * way that failed quietly: the capture script looks for `.mk-card`, that class
 * is also on the six outcome cards, so it silently captured one of those and
 * produced a 498×270 image of the wrong element. Keeping the source alive and
 * addressable is what stops that.
 *
 * Regenerate:  node scripts/capture-hero-gif.mjs   (THEME=dark for the pair)
 */

/* Fixed, not random: `Math.random()` would give the server and the client
   different numbers and React would fail hydration. */
const WAVE = [
  18, 34, 52, 30, 62, 44, 78, 56, 40, 68, 88, 54, 36, 70, 48, 82, 30, 58, 44, 74, 38, 62, 26,
  50, 66, 42, 76, 34, 56, 22,
];

/** The same call, in Tamil and in English. */
const TRANSCRIPT = {
  ta: {
    label: "Tamil",
    customer: "20,000 bricks venum, Perundurai site-ku. Rate enna irukku?",
    agent: "Interlock-ku ₹32 per unit. Advance 50% kudutha Friday delivery.",
  },
  en: {
    label: "English",
    customer: "I need 20,000 bricks for the Perundurai site. What's your rate?",
    agent: "₹32 per unit for interlock. Pay 50% advance and we deliver Friday.",
  },
};

const EXTRACTED = [
  ["Quantity", "20,000 units"],
  ["Product", "Interlock brick"],
  ["Site", "Perundurai"],
  ["Rate quoted", "₹32 / unit"],
  ["Value", "₹6,40,000"],
  ["Next step", "Advance by Friday"],
];

export function CallCard() {
  return (
    <div id="call-card" className="mk-card relative p-6 sm:p-7">
      <div
        className="mb-5 flex items-center justify-between text-xs font-semibold uppercase tracking-widest"
        style={{ color: "var(--mk-muted)" }}
      >
        <span>Incoming call</span>
        {/* Switches in step with the transcript, so the cross-fade reads as
            "now in Tamil / now in English" rather than as the text changing
            for no stated reason. */}
        <span className="mk-lang" aria-hidden="true">
          <span className="mk-lang-a mk-gradient-text text-right">{TRANSCRIPT.ta.label}</span>
          <span className="mk-lang-b mk-gradient-text text-right">{TRANSCRIPT.en.label}</span>
        </span>
      </div>

      <div className="mb-6 flex h-14 items-end gap-[3px]" aria-hidden="true">
        {WAVE.map((h, i) => (
          <span
            key={i}
            className="mk-wave-bar"
            style={{
              height: `${h}%`,
              opacity: 0.35 + (h / 100) * 0.55,
              // Negative delays start every bar mid-cycle, so the row is
              // already a wave on the first frame instead of thirty bars
              // rising together and then falling apart into one.
              animationDelay: `${-(i * 90)}ms`,
            }}
          />
        ))}
      </div>

      <div className="mk-lang" aria-hidden="true">
        <div className="mk-lang-a space-y-3">
          <Bubble who="Customer" tone="muted">
            {TRANSCRIPT.ta.customer}
          </Bubble>
          <Bubble who="Agent" tone="brand">
            {TRANSCRIPT.ta.agent}
          </Bubble>
        </div>
        <div className="mk-lang-b space-y-3">
          <Bubble who="Customer" tone="muted">
            {TRANSCRIPT.en.customer}
          </Bubble>
          <Bubble who="Agent" tone="brand">
            {TRANSCRIPT.en.agent}
          </Bubble>
        </div>
      </div>

      <div
        className="mt-6 rounded-2xl border p-4"
        style={{ borderColor: "var(--mk-line)", background: "var(--mk-ground)" }}
      >
        <div
          className="mb-3 text-xs font-semibold uppercase tracking-widest"
          style={{ color: "var(--mk-muted)" }}
        >
          Extracted · sent to your CRM
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {EXTRACTED.map(([k, v]) => (
            <div key={k}>
              <dt style={{ color: "var(--mk-muted)" }}>{k}</dt>
              <dd className="font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function Bubble({
  who,
  tone,
  children,
}: {
  who: string;
  tone: "muted" | "brand";
  children: React.ReactNode;
}) {
  const brand = tone === "brand";
  return (
    <div
      className="rounded-2xl px-4 py-3 text-sm leading-relaxed"
      style={{
        background: brand ? "color-mix(in srgb, var(--brand-mid) 10%, transparent)" : "var(--mk-ground)",
        border: `1px solid ${brand ? "color-mix(in srgb, var(--brand-mid) 26%, transparent)" : "var(--mk-line)"}`,
      }}
    >
      <span
        className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-widest"
        style={{ color: brand ? "var(--brand-mid)" : "var(--mk-muted)" }}
      >
        {who}
      </span>
      {children}
    </div>
  );
}
