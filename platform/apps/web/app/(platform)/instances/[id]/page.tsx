import Link from "next/link";
import { Boxes, KeyRound, Phone, Plug, Settings2 } from "lucide-react";
import {
  EmptyState,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { operatorGate } from "@/lib/operator-gate";
import { loadInstances, loadRecentCalls } from "./instance-data";
import {
  CALL_TONE,
  InstanceHeading,
  JUMP,
  SCROLLER,
  TablePanel,
  callLabel,
  formatDuration,
} from "./instance-ui";

/**
 * One customer at a glance: the jumps a person most often wants, and what each
 * of their instances has recently recorded.
 *
 * The header, the vitals strip and the tab strip are all drawn by `layout.tsx`,
 * which every page here shares. This file is the Overview PANEL and nothing
 * more - before doc 34 Part B it was one of five `content` nodes inside a
 * client-side tab component in a 1171-line file.
 *
 * `id` is the customer's org id - the tenant boundary the instance lives in.
 */
export default async function InstanceOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const instances = await loadInstances(orgId);
  const recentCalls = await loadRecentCalls(orgId, instances);
  // The instance name only needs saying when there is more than one to tell
  // apart. With exactly one - the shape of every customer provisioned so far -
  // it would restate the page title and the tab label.
  const multi = instances.length > 1;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Link href={`/instances/${orgId}/calls`} className={JUMP}>
          <Phone aria-hidden="true" className="h-4 w-4 text-text-muted" />
          Open call log
        </Link>
        {/* These four were `<button data-goto-tab="...">`, switching a panel in
            place. Plain links now that each panel is a route - so they can be
            middle-clicked, opened in a new tab, and returned from. */}
        <Link href={`/instances/${orgId}/devices#enrollment`} className={JUMP}>
          <KeyRound aria-hidden="true" className="h-4 w-4 text-text-muted" />
          Issue enrollment key
        </Link>
        <Link href={`/instances/${orgId}/settings`} className={JUMP}>
          <Settings2 aria-hidden="true" className="h-4 w-4 text-text-muted" />
          Owner logins &amp; modules
        </Link>
        {/* Unconditional, where the old button was gated on the CRM catalogue
            having loaded. The catalogue was fetched by this page only to decide
            whether to offer the jump; the lead-delivery route fetches it for
            itself and says so when the tenant has nothing to configure, which
            is a better answer than a missing button. */}
        <Link href={`/instances/${orgId}/lead-delivery`} className={JUMP}>
          <Plug aria-hidden="true" className="h-4 w-4 text-text-muted" />
          Lead delivery
        </Link>
      </div>

      {instances.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-8 w-8" />}
          title="This tenant has no enrollment target"
          description="There is no instance to enroll a handset against. Reprovision the customer to create one."
        />
      ) : null}

      {instances.map((inst, i) => {
        const calls = recentCalls[i]?.calls ?? [];
        return (
          <div key={inst.id} className="space-y-3">
            {multi ? <InstanceHeading inst={inst} /> : null}
            <TablePanel
              icon={<Phone className="h-4 w-4" />}
              title="Recent calls"
              action={
                <Link
                  href={`/instances/${orgId}/calls?instance=${inst.id}`}
                  className="rounded-sm text-sm font-medium text-accent-text underline underline-offset-2 hover:text-accent"
                >
                  View all
                  {/* One "View all" per instance; name the target so a screen
                      reader's link list is not N identical rows. */}
                  <span className="sr-only"> calls for {inst.name}</span>
                </Link>
              }
              empty={
                calls.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-text-muted">
                    No calls recorded on this instance yet
                  </p>
                ) : undefined
              }
            >
              <div
                tabIndex={0}
                role="region"
                aria-label={`Recent calls, ${inst.name}`}
                className={SCROLLER}
              >
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <caption className="sr-only">Recent calls for {inst.name}</caption>
                  <TableHead>
                    <tr>
                      <TableHeaderCell>Call</TableHeaderCell>
                      <TableHeaderCell>Device</TableHeaderCell>
                      <TableHeaderCell className="text-right">Duration</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {calls.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="py-2.5">
                          <span className="block text-sm font-medium text-text">
                            {callLabel(c)}
                          </span>
                          <LocalTime
                            iso={c.started_at}
                            className="text-xs text-text-muted tabular-nums"
                          />
                        </TableCell>
                        <TableCell className="py-2.5 text-xs">{c.device_label ?? "-"}</TableCell>
                        <TableCell className="py-2.5 text-right text-xs tabular-nums">
                          {formatDuration(c.duration_s)}
                        </TableCell>
                        <TableCell className="py-2.5">
                          <StatusChip tone={CALL_TONE(c.status)}>{c.status}</StatusChip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </table>
              </div>
            </TablePanel>
          </div>
        );
      })}
    </>
  );
}
