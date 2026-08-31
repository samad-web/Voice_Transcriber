import { Section, SectionHeading } from "../ui/layout";
import { ButtonLink } from "../ui/button";
import { ComparisonTable, Verdict } from "../ui/content";
import { OEM_MATRIX, STATUS_LABEL } from "@/lib/content/compatibility";

/**
 * Phone compatibility (doc 10 §3 row 8) - objection #2, answered on the
 * homepage with the matrix itself rather than a link and a hedge.
 *
 * The unsupported row is not buried at the bottom of a page nobody scrolls to.
 * Doc 10 §1: "Naming your limits precisely buys credibility on everything
 * else." A buyer who finds out about the Google Dialer limitation after paying
 * is a refund and a bad reference; one who finds out here is a buyer who trusts
 * the rest of the page.
 */
export function CompatibilityTeaser() {
  return (
    <Section id="compatibility" labelledBy="compat-heading">
      <SectionHeading
        id="compat-heading"
        eyebrow="Compatibility"
        title="Will it work on my team's phones?"
        lead="Capture depends on the handset maker, so here is the whole list, including the phones it will never work on."
      />

      <div className="mt-10">
        <ComparisonTable
          caption="Call capture support by handset manufacturer"
          columns={["Handset", "Capture", "Where the recording lives"]}
          rows={OEM_MATRIX.map((row) => ({
            header: row.brand,
            cells: [
              <Verdict key="v" ok={row.status !== "unsupported"}>
                {STATUS_LABEL[row.status]}
              </Verdict>,
              <span key="p" className="tabular text-sm">
                {row.path}
              </span>,
            ],
          }))}
        />
      </div>

      <p className="mt-6 max-w-3xl text-base text-text-muted">
        Pixel, Motorola and Nokia handsets use the Google Dialer, which stores its
        recordings in private app storage that Android blocks every other app from
        reading. That is confirmed on hardware. There is no setting and no future
        version of Aura that changes it, if your team is on those phones, this
        product is not for you, and we would rather say so now.
      </p>

      <div className="mt-6">
        <ButtonLink href="/compatibility" variant="secondary">
          The full compatibility matrix
        </ButtonLink>
      </div>
    </Section>
  );
}
