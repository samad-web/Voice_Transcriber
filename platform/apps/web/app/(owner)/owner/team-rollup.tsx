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
 */
export function TeamRollup({ data, days }: { data: TeamRollupData; days: number }) {
  const { members, totals } = data;
  if (members.length === 0) return null;

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <MonoLabel>Who is carrying what</MonoLabel>
        <p className="text-xs text-text-muted tabular-nums">
          {totals.people} {totals.people === 1 ? "person" : "people"} · {totals.openDeals} open{" "}
          {totals.openDeals === 1 ? "deal" : "deals"} · {formatValue(totals.openValue)} · won in{" "}
          {days}d: {totals.wonDeals}
        </p>
      </div>

      <ul className="mt-3 divide-y divide-border">
        {members.map((member) => (
          <TeamRow
            key={member.userId ?? "unassigned"}
            member={member}
            totalOpenValue={totals.openValue}
            days={days}
          />
        ))}
      </ul>
    </Card>
  );
}

function TeamRow({
  member,
  totalOpenValue,
  days,
}: {
  member: TeamMember;
  totalOpenValue: number;
  days: number;
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
          label={`Won in ${days}d`}
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
