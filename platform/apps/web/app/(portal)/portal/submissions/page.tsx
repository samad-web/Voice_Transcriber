import type { Metadata } from "next";
import {
  PARTNER_SUBMISSION_OUTCOME_LABELS,
  PartnerSubmissionOutcome,
} from "@aura/shared/dist/partners";
import { Card, EmptyState, StatCard, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { portalGet } from "../../portal-context";

export const metadata: Metadata = { title: "My submissions" };

interface Submission {
  id: string;
  outcome: string;
  reject_reason: string | null;
  lead_name: string | null;
  lead_phone: string | null;
  lead_email: string | null;
  note: string | null;
  submitted_at: string;
  decided_at: string | null;
}

interface Totals {
  total: string;
  submitted: string;
  accepted: string;
  rejected: string;
  converted: string;
}

/**
 * An outcome is a CATEGORY, not a call state - so it is a `StatusChip`, and
 * three of the four tones are grey.
 *
 * The first draft hand-rolled a pill with `bg-success-subtle text-success-text`
 * for `converted` and an accent fill for `accepted`. `console-palette.test.ts`
 * caught it, correctly: re-implementing the state chip without its GLYPH means
 * colour alone carries the difference, which fails WCAG 1.4.1, disappears in
 * the greyscale screenshots this market pastes into WhatsApp, and - the reason
 * the rule exists - spends two more hues on a surface where green then stops
 * meaning anything. `StatusChip`'s own header says it: a category is not a
 * state and does not get a hue.
 *
 * ── WHY `rejected` IS NOT THE `danger` TONE ────────────────────────────────
 *
 * `danger` is the one tone StatusChip still colours, and it is orange rather
 * than red because red means MISSED and only missed. What it marks is
 * "something the system failed at". A tenant deciding not to pursue a referral
 * is not a failure of anything - it is an ordinary commercial answer, and
 * painting it as an error every time would make the portal read as hostile to
 * the person whose referral it was.
 *
 * ── AND WHY TWO OUTCOMES SHARE `outline` ──────────────────────────────────
 *
 * There are four outcomes and three non-error tones. `submitted` and
 * `rejected` share the hollow ring, which reads "nothing is happening here" -
 * true of a referral not yet looked at and of one closed without being taken
 * up. The two are never confused, because the chip's TEXT is what names the
 * status ("Submitted" / "Not taken forward") and the glyph is a redundant
 * encoding of the tone, not of the label. Inventing a fourth hue to separate
 * them would be spending colour on a category, which is the whole thing the
 * rule forbids.
 */
const OUTCOME_TONE: Record<string, "solid" | "muted" | "outline"> = {
  // Nothing has happened yet.
  submitted: "outline",
  // With the team, being worked - "neutral / informational".
  accepted: "muted",
  // The one that counts, and the only one with money behind it.
  converted: "solid",
  // Closed, and not an error.
  rejected: "outline",
};

function OutcomeChip({ outcome }: { outcome: string }) {
  const parsed = PartnerSubmissionOutcome.safeParse(outcome);
  const label = parsed.success ? PARTNER_SUBMISSION_OUTCOME_LABELS[parsed.data] : outcome;
  return <StatusChip tone={OUTCOME_TONE[outcome] ?? "outline"}>{label}</StatusChip>;
}

/**
 * Screen two (Build docs/39 §19): everything this partner has sent, and the
 * COARSE outcome of each.
 *
 * ── WHAT IS NOT ON THIS PAGE, AND WHY IT NEVER WILL BE ────────────────────
 *
 * The lead's stage. Who it was assigned to. What it was valued at. Whether
 * anyone has rung it, and what was said. None of that is withheld because it
 * is hard to fetch - the API does not return it and migration 0163's wall
 * means this request could not read it if it tried.
 *
 * §18 has the argument in one sentence: a broker who can watch every
 * prospect's stage and budget holds the tenant's pipeline. The four outcomes
 * below are statements the tenant chose to make. Everything else is the
 * tenant's business, and they can send a partner statement from Report Builder
 * when they want to.
 */
export default async function PortalSubmissionsPage() {
  const data = await portalGet<{ submissions: Submission[]; totals: Totals }>(
    "/v1/portal/submissions?limit=100",
  );

  if (!data) {
    return (
      <>
        <PageHeader title="My submissions" />
        <EmptyState
          title="We couldn't load your submissions"
          description="The portal didn't answer. Reload the page in a moment."
        />
      </>
    );
  }

  const { submissions, totals } = data;
  const n = (value: string | undefined) => Number(value ?? 0);

  return (
    <>
      <PageHeader title="My submissions" description="Everything you have sent, and what came of it." />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Sent" value={n(totals?.total)} />
        <StatCard label="Awaiting a decision" value={n(totals?.submitted)} />
        <StatCard label="Accepted" value={n(totals?.accepted)} />
        <StatCard label="Converted" value={n(totals?.converted)} />
      </div>

      {submissions.length === 0 ? (
        <EmptyState
          title="You haven't sent anything yet"
          description="Referrals you send from Submit a lead show up here, with the outcome beside each one."
        />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-border text-left text-xs text-text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Who</th>
                <th scope="col" className="px-4 py-3 font-medium">Sent</th>
                <th scope="col" className="px-4 py-3 font-medium">Outcome</th>
                <th scope="col" className="px-4 py-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium text-text">{s.lead_name || s.lead_phone || s.lead_email || "—"}</p>
                    {s.lead_name && (s.lead_phone || s.lead_email) ? (
                      <p className="text-xs text-text-muted">{s.lead_phone || s.lead_email}</p>
                    ) : null}
                  </td>
                  {/* The DATE only, in the workspace's own words rather than
                      a formatted local time. `toLocaleString` on a server
                      component renders in the server's locale and then again
                      in the browser's, which is the hydration mismatch the
                      call log already carries - not worth reproducing for a
                      column nobody sorts by. */}
                  <td className="px-4 py-3 whitespace-nowrap text-text-muted">
                    {s.submitted_at.slice(0, 10)}
                  </td>
                  <td className="px-4 py-3">
                    <OutcomeChip outcome={s.outcome} />
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {/* The tenant's reason, in the tenant's words, when they
                        gave one. This is the only channel through which a
                        partner learns WHY, and a portal that showed a bare
                        "Not taken forward" would generate a phone call
                        every single time. */}
                    {s.reject_reason ? <p className="text-text">{s.reject_reason}</p> : null}
                    {s.note ? <p className="line-clamp-2">{s.note}</p> : null}
                    {!s.reject_reason && !s.note ? "—" : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
