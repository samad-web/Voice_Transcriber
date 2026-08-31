import { notFound } from "next/navigation";
import { CallCard } from "@/components/call-card";

/**
 * The capture stage for the hero animation. DEVELOPMENT ONLY.
 *
 * scripts/capture-hero-gif.mjs points Playwright here, records the card and
 * converts it to the animated WebP + GIF pair that the homepage ships. Having
 * a dedicated route rather than scraping the homepage means the capture cannot
 * grab the wrong element - `.mk-card` is also the class on the six outcome
 * cards, and when the homepage stopped rendering the call card the script
 * silently captured one of those instead and produced a 498×270 image of a
 * paragraph.
 *
 * `notFound()` in production is not a nicety. This page renders one component
 * on a bare ground with no header, no footer and no way back; shipping it live
 * would put a stray orphan page in the sitemap's blind spot and in search
 * results. It exists on a developer's machine, which is the only place an
 * asset gets regenerated.
 *
 * It is also disallowed in robots.txt, for the case where someone builds with
 * NODE_ENV unset.
 */
export default function CaptureHeroCard() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div
      style={{
        margin: 0,
        padding: 0,
        // The card's own surface, so the handful of pixels outside its rounded
        // corners blend rather than showing as bright notches. The page applies
        // the radius and the shadow in CSS - baking either into the raster put
        // a hard-edged rectangle on top of the hero's gradient wash.
        background: "var(--mk-surface)",
        display: "inline-block",
      }}
    >
      <CallCard />
    </div>
  );
}
