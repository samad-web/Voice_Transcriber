"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, Select, StatusChip, useAlert, useToast } from "@aura/ui";
import { offboardAction, offboardPreviewAction } from "./staff-actions";
import type { OffboardManifest, OffboardWork, TeamMember } from "./types";

/**
 * "Hand over work" - the offboarding dialog (migration 0198).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS A DIALOG AND NOT A CONFIRM
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `useConfirm` takes a sentence. This has to show a list that the owner reads
 * BEFORE deciding anything - 112 leads, 9 call-backs, two live handsets, and
 * the distribution rule about to be left with nobody in it - and then take a
 * choice of recipient. A confirmation that said "this will move their work"
 * without saying how much of it, or where, would be the same invisible
 * handover in a nicer wrapper.
 *
 * ── THE PREVIEW IS LOADED, NOT COMPUTED HERE ──────────────────────────────
 *
 * On open, from `GET .../offboard`. The numbers and the refusals have to come
 * from the same place the handover itself runs, or the dialog and the audit
 * row will disagree about what happened - which is exactly the sort of
 * disagreement nobody notices until somebody is looking for a lead that moved.
 *
 * ── AND WHY THERE IS NO "nobody" OPTION ───────────────────────────────────
 *
 * The recipient picker has no "leave it unassigned" entry and no default. An
 * owner has to name a colleague, which is the one product decision in this
 * whole feature: a hundred leads handed to a manager who did not ask for them,
 * triggered by somebody clicking a button called Suspend, is how a handover
 * becomes invisible - the bug this exists to fix, with extra steps.
 */

const LABELS: Array<[keyof OffboardWork, string, string]> = [
  ["leads", "lead", "leads"],
  ["callbacks", "open call-back", "open call-backs"],
  ["tasks", "open task", "open tasks"],
  ["taskSeats", "shared task", "shared tasks"],
  ["dealsOwned", "deal they own", "deals they own"],
  ["dealsDesk", "deal on their desk", "deals on their desk"],
  ["contacts", "contact", "contacts"],
  ["accounts", "account", "accounts"],
  ["conversations", "shared chat", "shared chats"],
];

function lines(work: OffboardWork): Array<{ key: string; text: string }> {
  return LABELS.filter(([key]) => work[key] > 0).map(([key, one, many]) => ({
    key,
    text: `${work[key]} ${work[key] === 1 ? one : many}`,
  }));
}

export function OffboardDialog({
  member,
  colleagues,
  open,
  onClose,
}: {
  member: TeamMember;
  /** Everybody else who could receive the work - active members only. */
  colleagues: TeamMember[];
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const alert = useAlert();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [manifest, setManifest] = useState<OffboardManifest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [devices, setDevices] = useState<"logout" | "remove" | "keep">("logout");

  // Re-read on every open rather than caching: the dialog may be opened a
  // second time after a handover, and stale counts would say work is still
  // there to move when it is not.
  useEffect(() => {
    if (!open) return;
    setManifest(null);
    setLoadError(null);
    setRecipient("");
    let live = true;
    void offboardPreviewAction(member.userId).then((res) => {
      if (!live) return;
      if (res.error) setLoadError(res.error);
      else setManifest(res.manifest ?? null);
    });
    return () => {
      live = false;
    };
  }, [open, member.userId]);

  const work = manifest ? lines(manifest.work) : [];
  const nothingToMove = manifest !== null && manifest.total === 0;
  // Leads and desk-assigned deals are keyed on a telecaller identity, so only
  // a colleague who HAS one can receive them. Filtering the picker rather than
  // letting the API refuse keeps the reason visible at the point of choosing.
  const eligible = colleagues.filter(
    (c) =>
      c.userId !== member.userId &&
      c.status !== "suspended" &&
      (!manifest?.needsTelecallerRecipient || (c.telecallerId && c.telecallerStatus === "active")),
  );
  const emptiedRules = manifest?.rules.filter((r) => r.othersActive === 0) ?? [];

  const commit = () => {
    startTransition(async () => {
      const res = await offboardAction(member.userId, {
        handoverTo: nothingToMove ? null : recipient || null,
        devices,
      });
      if (res.error) {
        await alert({
          title: `Couldn't hand over ${member.email}'s work`,
          body: res.error,
          tone: "danger",
        });
        return;
      }
      const moved = res.result ? lines(res.result.moved) : [];
      toast(
        moved.length
          ? `Moved ${moved.map((l) => l.text).join(", ")}`
          : "Nothing was outstanding to move",
      );
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Hand over ${member.name ?? member.email}'s work`}
      description="What they still hold, and who gets it. Their history stays theirs."
      dismissOnBackdrop={false}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={commit}
            loading={pending}
            // The one hard gate in the UI: open work and no named recipient.
            disabled={!manifest || (!nothingToMove && !recipient)}
          >
            Hand over
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        {loadError ? (
          <p className="text-danger">{loadError}</p>
        ) : !manifest ? (
          <p className="text-text-muted">Counting what they hold…</p>
        ) : (
          <>
            <section className="space-y-1.5">
              {work.length === 0 ? (
                <p className="text-text-muted">
                  Nothing is assigned to them. There is no work to move - this will still log
                  their handsets out and archive their desk.
                </p>
              ) : (
                <ul className="space-y-1">
                  {work.map((line) => (
                    <li key={line.key} className="text-text">
                      {line.text}
                    </li>
                  ))}
                </ul>
              )}
              {manifest.unreadNotifications > 0 ? (
                <p className="text-xs text-text-muted">
                  {manifest.unreadNotifications} unread notifications will be marked read - they
                  cannot sign in to see them.
                </p>
              ) : null}
            </section>

            {manifest.devices.length > 0 ? (
              <section className="space-y-2">
                <p className="font-medium text-text">
                  {manifest.devices.length === 1 ? "Their handset" : "Their handsets"}
                </p>
                <ul className="space-y-1">
                  {manifest.devices.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 text-text-muted">
                      <span className="text-text">{d.label ?? "Unlabelled handset"}</span>
                      {/* `solid` for a phone still recording, `outline` for one
                          already quiet - the kit's "on / not yet" pair. */}
                      <StatusChip tone={d.status === "active" ? "solid" : "outline"}>
                        {d.status}
                      </StatusChip>
                      <span className="text-xs">
                        {d.calls} {d.calls === 1 ? "call" : "calls"} recorded
                      </span>
                    </li>
                  ))}
                </ul>
                <label className="block space-y-1">
                  <span className="text-xs text-text-muted">What to do with them</span>
                  <Select
                    value={devices}
                    onChange={(e) =>
                      setDevices(e.target.value as "logout" | "remove" | "keep")
                    }
                  >
                    <option value="logout">Log out - stops recording, can be relinked</option>
                    <option value="remove">Remove from the fleet - keeps their calls</option>
                    <option value="keep">Leave them alone</option>
                  </Select>
                </label>
                <p className="text-xs text-text-muted">
                  A phone that is left alone goes on recording and uploading, because a handset
                  signs in as itself rather than as the person holding it. Neither option erases
                  anything already on it.
                </p>
              </section>
            ) : null}

            {nothingToMove ? null : (
              <section className="space-y-1">
                <label className="block space-y-1">
                  <span className="font-medium text-text">Who gets it</span>
                  <Select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                    <option value="">Choose a colleague…</option>
                    {eligible.map((c) => (
                      <option key={c.userId} value={c.userId}>
                        {c.name ? `${c.name} (${c.email})` : c.email}
                      </option>
                    ))}
                  </Select>
                </label>
                {eligible.length === 0 ? (
                  <p className="text-xs text-danger">
                    {manifest.needsTelecallerRecipient
                      ? "Leads are assigned to a telecaller identity, and nobody else here has " +
                        "one. Bind a colleague to one on this tab first."
                      : "There is nobody else active in this workspace to receive the work."}
                  </p>
                ) : (
                  <p className="text-xs text-text-muted">
                    Tasks arrive for them to accept or decline. Everything else simply becomes
                    theirs.
                  </p>
                )}
              </section>
            )}

            {emptiedRules.length > 0 ? (
              <p className="rounded-md border border-warning-text/30 bg-warning-subtle p-2 text-xs text-warning-text">
                Archiving their desk leaves{" "}
                <strong>{emptiedRules.map((r) => r.name).join(", ")}</strong> with no active
                targets, so leads matching{" "}
                {emptiedRules.length === 1 ? "that rule" : "those rules"} will arrive unassigned
                until somebody else is added on the Lead routing page.
              </p>
            ) : null}

            <p className="text-xs text-text-muted">
              Their name stays on every call they made and every lead they worked. Quotations and
              invoices keep their author. This moves only what is still somebody&apos;s job to do.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
