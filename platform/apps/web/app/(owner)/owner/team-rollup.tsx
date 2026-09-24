import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import {
  needsAttention,
  pipelineShare,
  teamDealsHref,
  teamHeadline,
  teamLeadsHref,
  teamTasksHref,
  type TeamMember,
  type TeamRollup as TeamRollupData,
} from "@/lib/team-rollup";
import { inSpan } from "@/lib/dashboard-charts";
import { formatValue } from "./types";

/**
 * Who is carrying what (CRM dashboard Phase 8).
 *
 * The manager's half of "role-based dashboards": a rep's landing page is their
 * own desk, and this is the same facts rolled up per person. Every number is a
 * link to the list that produced it, so "four late" is one tap from the four.
 *
 * ── WHY NOT A TABLE ──────────────────────────────────────────────────────
 *
 * A five-column table is unreadable on a phone, and a manager checking the
 * floor is very often on one. Each person is a card whose numbers reflow from
 * two columns to four, so nothing is hidden behind a horizontal scroll and no
 * second mobile-only markup has to be kept in step with this one.
 *
 * ── THE BAR ──────────────────────────────────────────────────────────────
 *
 * One measure, one hue (the accent the reports page already uses for bars),
 * capped at 6px and never carrying the text: it is a share of the team's open
 * pipeline, and the figure beside it is the number. A person with nothing open
 * has no bar rather than an empty track, so the eye lands on who is loaded.
 *
 * ── PEOPLE WITH NOTHING ARE FOLDED AWAY ──────────────────────────────────
 *
 * A workspace collects accounts - a viewer, somebody who left, a seat opened
 * for a trial - and a row of zeros for each buries the three people who are
 * actually carrying the floor. They are counted in one line that opens, rather
 * than dropped: "nobody has given this person anything" is a real answer a
 * manager sometimes needs, and a roll-up that silently omitted a name would be
 * the wrong kind of tidy. A `<details>` element, so it costs no client JS.
 */
export function TeamRollup({
  data,
  days,
  span,
}: {
  data: TeamRollupData;
  days: number;
  /** The window as a tile says it - "30d", or a custom range's dates. Defaults to `${days}d`. */
  span?: string;
}) {
  const { members, totals } = data;
  if (members.length === 0) return null;
  const within = span ?? `${days}d`;

  const carrying = members.filter((m) => m.userId === null || !isIdle(m));
  const idle = members.filter((m) => m.userId !== null && isIdle(m));

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <MonoLabel>Who is carrying what</MonoLabel>
        <p className="text-xs text-text-muted tabular-nums">
          {totals.people} {totals.people === 1 ? "person" : "people"} · {totals.openDeals} open{" "}
          {totals.openDeals === 1 ? "deal" : "deals"} · {formatValue(totals.openValue)} · won{" "}
          {inSpan(within)}: {totals.wonDeals}
        </p>
      </div>

      <ul aria-label="Who is carrying what" className="mt-3 divide-y divide-border">
        {carrying.map((member) => (
          <TeamRow
            key={member.userId ?? "unassigned"}
            member={member}
            totalOpenValue={totals.openValue}
            within={within}
          />
        ))}
      </ul>

      {idle.length > 0 ? (
        <details className="mt-3 border-t border-border pt-3">
          <summary className="cursor-pointer text-xs text-text-muted hover:text-text">
            {idle.length} {idle.length === 1 ? "person has" : "people have"} nothing assigned
          </summary>
          <ul aria-label="People with nothing assigned" className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {idle.map((member) => (
              <li key={member.userId} className="text-xs text-text-muted">
                {member.name}
                {member.ownerRole ? ` · ${member.ownerRole}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}

/** Nothing open and nothing won in the window - see the header. */
function isIdle(member: TeamMember): boolean {
  return (
    member.openDeals + member.openLeads + member.openTasks + member.wonDeals === 0
  );
}

function TeamRow({
  member,
  totalOpenValue,
  within,
}: {
  member: TeamMember;
  totalOpenValue: number;
  /** "30d", or a custom range's dates. */
  within: string;
}) {
  const headline = teamHeadline(member);
  const attention = needsAttention(member);
  const share = pipelineShare(member, totalOpenValue);
  const leadsHref = teamLeadsHref(member);
  const lateLeadsHref = teamLeadsHref(member, true);

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm font-medium break-words text-text">
          {member.name}
          {member.ownerRole ? (
            <span className="ml-2 text-xs font-normal text-text-muted">{member.ownerRole}</span>
          ) : null}
        </p>
        {headline ? (
          <p
            className={`text-xs ${
              attention
                ? "rounded-full border border-border-strong px-2 py-0.5 font-medium text-text"
                : "text-text-subtle"
            }`}
          >
            {headline}
          </p>
        ) : null}
      </div>

      {/* Two columns on a phone, four from sm - the same numbers either way. */}
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Figure
          label="Open deals"
          value={`${member.openDeals}`}
          detail={member.openValue > 0 ? formatValue(member.openValue) : undefined}
          href={member.openDeals > 0 ? teamDealsHref(member) : undefined}
        />
        <Figure
          label={`Won ${inSpan(within)}`}
          value={`${member.wonDeals}`}
          detail={member.wonValue > 0 ? formatValue(member.wonValue) : undefined}
        />
        <Figure
          label="Follow-ups"
          value={`${member.openTasks}`}
          detail={member.overdueTasks > 0 ? `${member.overdueTasks} overdue` : undefined}
          emphasis={member.overdueTasks > 0}
          href={member.openTasks > 0 ? teamTasksHref(member, member.overdueTasks > 0) : undefined}
        />
        <Figure
          label="Open leads"
          value={`${member.openLeads}`}
          detail={member.unansweredLeads > 0 ? `${member.unansweredLeads} unanswered` : undefined}
          emphasis={member.unansweredLeads > 0}
          href={
            member.openLeads > 0
              ? ((member.unansweredLeads > 0 ? lateLeadsHref : leadsHref) ?? undefined)
              : undefined
          }
        />
      </dl>

      {share > 0 ? (
        <div
          aria-hidden="true"
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-hover"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * One number. A link when there is something to open, plain text when there is
 * not - a zero that navigates to an empty list is a worse answer than a zero.
 */
function Figure({
  label,
  value,
  detail,
  href,
  emphasis = false,
}: {
  label: string;
  value: string;
  detail?: string;
  href?: string;
  emphasis?: boolean;
}) {
  const body = (
    <>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="text-sm font-semibold text-text tabular-nums">
        {value}
        {detail ? (
          <span
            className={`ml-1.5 text-xs font-normal ${emphasis ? "text-text" : "text-text-muted"}`}
          >
            {detail}
          </span>
        ) : null}
      </dd>
    </>
  );

  // A 40px row on a phone: this is a tap target on a screen somebody is
  // holding one-handed, not a figure in a printed report.
  return href ? (
    <Link
      href={href}
      className="-mx-2 flex min-h-10 flex-col justify-center rounded-md px-2 hover:bg-surface-hover sm:min-h-0 sm:py-0.5"
    >
      {body}
    </Link>
  ) : (
    <div className="-mx-2 flex min-h-10 flex-col justify-center px-2 sm:min-h-0 sm:py-0.5">
      {body}
    </div>
  );
}
