import { ScrollText } from "lucide-react";
import {
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { operatorGate } from "@/lib/operator-gate";
import { loadAudit, loadOrg } from "../instance-data";
import { AUDIT_CAP, TablePanel } from "../instance-ui";

/** What was done to this customer's workspace, newest first. */
export default async function InstanceAuditPage({ params }: { params: Promise<{ id: string }> }) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const [org, auditEntries] = await Promise.all([loadOrg(orgId), loadAudit(orgId)]);

  return (
    <>
      {/* Says the two things the table cannot: that nothing here can be edited or
          deleted, and that it is a window rather than the whole history. Both
          matter before someone reads a gap in it as "nothing happened". */}
      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
        Append-only. Every entry is written by the API as the action happens and
        nothing in this console can change or remove one. The newest {AUDIT_CAP} are shown.
      </p>

      <TablePanel
        icon={<ScrollText className="h-4 w-4" />}
        title="Immutable audit ledger"
        action={
          <span className="text-xs text-text-muted tabular-nums">
            {auditEntries.length} {auditEntries.length === 1 ? "entry" : "entries"}
            {/* The API caps at 200 (tenancy.controller.ts). Saying so beats a
                list that silently stops at an arbitrary depth. */}
            {auditEntries.length >= AUDIT_CAP ? " · newest 200" : ""}
          </span>
        }
        empty={
          auditEntries.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-text-muted">No audit entries yet</p>
          ) : undefined
        }
      >
        {/* Full width now that it owns a route - it used to be a 32rem box beside
            an eight-screen settings column, so it was both cramped AND surrounded
            by empty page. Still capped in height, though: 200 entries laid out
            down the page would be 8,000px of scroll, which is the problem this
            redesign exists to remove. The log scrolls inside its own frame and the
            page stays one screen. */}
        <div
          tabIndex={0}
          role="region"
          aria-label="Audit ledger"
          className="max-h-[70vh] overflow-auto"
        >
          <table className="w-full min-w-[560px] border-collapse text-left text-sm">
            <caption className="sr-only">Audit ledger for {org.name}</caption>
            <TableHead>
              <tr>
                <TableHeaderCell>Action</TableHeaderCell>
                <TableHeaderCell>Actor</TableHeaderCell>
                <TableHeaderCell>Target</TableHeaderCell>
                <TableHeaderCell>When</TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {auditEntries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="py-2.5 font-mono text-xs font-medium text-text">
                    {e.action}
                  </TableCell>
                  <TableCell className="py-2.5 font-mono text-xs text-text-muted">
                    {e.actor_type}:{e.actor_id.slice(0, 12)}
                  </TableCell>
                  <TableCell className="py-2.5">
                    <StatusChip tone={e.actor_type === "system" ? "muted" : "solid"}>
                      {e.target_type ?? "-"}
                    </StatusChip>
                  </TableCell>
                  <TableCell className="py-2.5">
                    <LocalTime iso={e.created_at} className="text-xs text-text-muted tabular-nums" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </table>
        </div>
      </TablePanel>
    </>
  );
}
