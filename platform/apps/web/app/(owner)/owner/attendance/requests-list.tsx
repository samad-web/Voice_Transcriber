"use client";

import { useState, useTransition } from "react";
import { Button, Card, Dialog, EmptyState, FormField, StatusChip, useToast } from "@aura/ui";
import { LEAVE_TYPE_LABELS, describeRequest } from "@aura/shared";
import { Time } from "@/components/org-time";
import { inputClass } from "@/lib/form";
import { useServerState } from "@/lib/use-server-state";
import type { AttendanceRequest } from "@/lib/attendance";
import { decideRequestAction } from "./actions";

const KIND_LABEL: Record<string, string> = { leave: "Leave", break: "Break", hours_change: "Hours change" };

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  auto_approved: "Approved automatically",
  cancelled: "Cancelled",
};

/** attendance_whatsapp_outbox.status (0140). */
const WHATSAPP_LABEL: Record<string, string> = {
  queued: "WhatsApp sending",
  sent: "Sent on WhatsApp",
  failed: "WhatsApp not delivered",
  skipped: "WhatsApp not sent (no number, or alerts off)",
};

function whatsappFailed(status: string): boolean {
  return status === "failed";
}

/**
 * The Requests tab's list (doc 33 §6.3, §7.1). Approve and Reject show only
 * where the API says `canDecide` - the assigned manager or an owner, never the
 * person whose request it is - so the buttons agree with the rule that
 * enforces them. Rejecting needs a note; approving takes one optionally.
 */
export function RequestsList({ initial, zone }: { initial: AttendanceRequest[]; zone: string }) {
  const toast = useToast();
  const [requests, setRequests] = useServerState(initial);
  const [deciding, setDeciding] = useState<{ request: AttendanceRequest; decision: "approve" | "reject" } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const close = () => {
    if (pending) return;
    setDeciding(null);
    setNote("");
    setError(null);
  };

  const submit = () => {
    if (!deciding) return;
    const { request, decision } = deciding;
    if (decision === "reject" && !note.trim()) {
      setError("Say why - the telecaller sees this note.");
      return;
    }
    startTransition(async () => {
      const result = await decideRequestAction(request.id, { decision, note: note.trim() || null });
      if (result.error) {
        setError(result.fieldErrors?.note ?? result.error);
        return;
      }
      const updated = result.request;
      setRequests((list) => (updated ? list.map((r) => (r.id === request.id ? updated : r)) : list));
      toast(decision === "approve" ? `Approved for ${request.telecallerName}` : `Rejected for ${request.telecallerName}`);
      setDeciding(null);
      setNote("");
      setError(null);
    });
  };

  if (requests.length === 0) {
    return <EmptyState title="Nothing here" description="Requests from telecallers show here as they arrive." />;
  }

  return (
    <>
      <ul className="space-y-3">
        {requests.map((r) => {
          const what = describeRequest({ ...r, zone });
          return (
            <li key={r.id}>
              <Card className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-text">
                      <span className="font-medium">{r.telecallerName}</span>
                      <span className="text-text-muted"> · {KIND_LABEL[r.kind] ?? r.kind}</span>
                      {r.leaveType ? (
                        <span className="text-text-muted"> · {LEAVE_TYPE_LABELS[r.leaveType] ?? r.leaveType}</span>
                      ) : null}
                    </p>
                    <p className="text-sm font-medium text-text tabular-nums">{what}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.escalatedAt && r.status === "pending" ? <StatusChip tone="outline">Escalated</StatusChip> : null}
                    <StatusChip tone={r.status === "pending" ? "outline" : "muted"}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </StatusChip>
                    {r.whatsapp ? (
                      <StatusChip tone={whatsappFailed(r.whatsapp.status) ? "danger" : "muted"}>
                        {WHATSAPP_LABEL[r.whatsapp.status] ?? `WhatsApp: ${r.whatsapp.status}`}
                      </StatusChip>
                    ) : null}
                  </div>
                </div>

                {r.reason ? <p className="text-sm text-text-muted">&ldquo;{r.reason}&rdquo;</p> : null}

                <p className="text-xs text-text-muted">
                  {r.status === "pending" ? (
                    <>
                      With {r.approverName ?? "the owners"}
                      {r.escalatedAt ? " and the owners" : ""} · asked <Time iso={r.createdAt} mode="relative" />
                    </>
                  ) : (
                    <>
                      {r.decidedByName ? `${STATUS_LABEL[r.status] ?? r.status} by ${r.decidedByName}` : STATUS_LABEL[r.status]}
                      {r.decidedAt ? (
                        <>
                          {" "}
                          · <Time iso={r.decidedAt} mode="datetime" />
                        </>
                      ) : null}
                    </>
                  )}
                  {r.source === "console" || r.source === "on_behalf" ? " · recorded in the console" : ""}
                </p>
                {r.decisionNote ? <p className="text-xs text-text">Note: {r.decisionNote}</p> : null}
                {r.whatsapp && whatsappFailed(r.whatsapp.status) && r.whatsapp.lastError ? (
                  <p className="text-xs text-text-muted">WhatsApp said: {r.whatsapp.lastError}</p>
                ) : null}

                {r.canDecide && r.status === "pending" ? (
                  <div className="flex gap-2 pt-1">
                    <Button type="button" size="sm" onClick={() => setDeciding({ request: r, decision: "approve" })}>
                      Approve
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setDeciding({ request: r, decision: "reject" })}
                    >
                      Reject
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>

      <Dialog
        open={deciding !== null}
        onClose={close}
        title={deciding?.decision === "reject" ? "Reject this request" : "Approve this request"}
        description={
          deciding ? `${deciding.request.telecallerName}: ${describeRequest({ ...deciding.request, zone })}` : undefined
        }
        footer={
          <>
            <Button type="button" variant="ghost" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} loading={pending}>
              {deciding?.decision === "reject" ? "Reject" : "Approve"}
            </Button>
          </>
        }
      >
        <FormField
          label={deciding?.decision === "reject" ? "Why" : "Note (optional)"}
          name="decision-note"
          required={deciding?.decision === "reject"}
          error={error}
          hint="The telecaller sees this on their phone."
        >
          <textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </FormField>
      </Dialog>
    </>
  );
}
