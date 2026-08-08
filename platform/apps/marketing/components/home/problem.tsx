import { Section } from "../ui/layout";

/**
 * The problem, in the owner's words. Doc 10 §3 row 2: typography only, no
 * illustration — the point is recognition, and a stock graphic gets in the way
 * of it.
 *
 * The 400-calls figure is illustrative and reads as such in context ("your
 * team"), not as a measured customer statistic. Doc 10 §15 bans invented
 * numbers presented as proof; this is a scenario, and it is deliberately not
 * attributed to anyone.
 */
export function Problem() {
  return (
    <Section id="problem" tone="subtle" labelledBy="problem-heading">
      <div className="max-w-3xl">
        <h2
          id="problem-heading"
          className="text-3xl font-semibold tracking-tight text-text text-balance sm:text-4xl"
        >
          Your team made 400 calls last month. You listened to none of them.
        </h2>
        <p className="mt-6 text-xl text-text-muted text-pretty">
          You know the total. You don&rsquo;t know why eleven deals died, which
          objection keeps landing, what your competitor is quoting, or who promised a
          customer a callback and never made it.
        </p>
      </div>
    </Section>
  );
}
