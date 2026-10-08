"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  EmptyState,
  ErrorBanner,
  MonoLabel,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useConfirm,
  useToast,
} from "@aura/ui";
import {
  DIAL_BLOCK_LABELS,
  DIAL_BLOCK_ORDER,
  type DialBlockReason,
} from "@aura/shared/dist/dialable";
import type {
  DialCampaignView,
  DialPreviewCounts,
  DialSettingsView,
} from "@aura/shared/dist/dialer";
import { useServerState } from "@/lib/use-server-state";
import type { SavedView } from "@/lib/list-views";
import {
  activateCampaignAction,
  buildQueueAction,
  pauseCampaignAction,
  previewCampaignAction,
} from "./actions";
import { CampaignEditor } from "./campaign-editor";
import { DialPolicyCard } from "./dial-policy-card";

/**
 * The dialer console (Build docs/40 §B1, migrations 0159-0162).
 *
 * ── THE ORDER OF THIS PAGE IS AN ARGUMENT ──────────────────────────────────
 *
 * Policy first, campaigns second. The dial policy card carries the per-person
 * ceiling, and doc 39 shipped that ceiling UNCAPPED on the explicit condition
 * that it sits where `maxAttempts` is chosen rather than on a settings page
 * nobody opens. Putting the campaign list first would satisfy the letter of
 * that and miss the point: an owner setting "5 attempts" needs the sentence
 * "no daily limit per person" already read, not one scroll away.
 *
 * ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
 *
 * No dial button. No softphone, no WebRTC, no bridging, no carrier, no virtual
 * number. The HANDSET dials - it asks `/v1/devices/me/dialer/next` and reports
 * back - and this console assigns and watches. A dial button here would be the
 * first line of an IVR, which is a standing product decision, not a gap.
 *
 * No second opinion on dialability either. Every count below comes from the API
 * running `dialability()`, the one predicate the preview, the queue build and
 * the handset's claim all share. A number computed in the browser is how a
 * supervisor comes to believe a record is dialable that the phone will refuse.
 */
export function DialerConsole({
  campaigns: initialCampaigns,
  settings,
  savedViews,
  workspaceId,
}: {
  campaigns: DialCampaignView[];
  settings: DialSettingsView;
  savedViews: SavedView[];
  workspaceId: string | null;
}) {
  const [campaigns, setCampaigns] = useServerState(initialCampaigns);

  return (
    <div className="space-y-5">
      <DialPolicyCard initial={settings} />

      <CampaignEditor
        savedViews={savedViews}
        workspaceId={workspaceId}
        canCreate={settings.canEdit}
        onCreated={(campaign) => setCampaigns((list) => [campaign, ...list])}
      />

      {campaigns.length === 0 ? (
        <EmptyState
          title="No call campaigns yet"
          description="A campaign is a list of people to ring, in an order, with a limit on how many times each one may be tried. Build one above and the phones on the floor will start asking for records from it."
        />
      ) : (
        <div className="space-y-4">
          {campaigns.map((campaign) => (
            <CampaignRow
              key={campaign.id}
              campaign={campaign}
              canEdit={settings.canEdit}
              onChanged={(next) =>
                setCampaigns((list) => list.map((c) => (c.id === next.id ? next : c)))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * `status` as a chip, over `StatusChip`'s four tones rather than `StateChip`.
 *
 * `StateChip` is for CALL states - missed, answered, outgoing, error - and its
 * tone is deliberately not overridable, because red means MISSED in this console
 * and orange means an error. A campaign status is neither: "paused" is a thing
 * somebody chose, not a fault, and rendering it in the error orange would teach
 * the colour the wrong meaning on every other screen too.
 *
 * So: `outline` (a hollow ring - "not yet") for a draft, `solid` (a filled disc
 * - "on") for active, and `muted` (a bar - "informational") for the two states
 * that are neither. Nothing here is `danger`.
 */
const STATUS_TONE: Record<DialCampaignView["status"], "solid" | "muted" | "outline"> = {
  draft: "outline",
  active: "solid",
  paused: "muted",
  completed: "muted",
};

function CampaignRow({
  campaign,
  canEdit,
  onChanged,
}: {
  campaign: DialCampaignView;
  canEdit: boolean;
  onChanged: (next: DialCampaignView) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DialPreviewCounts | null>(null);

  const run = (work: () => Promise<{ error?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (result.error) {
        setError(result.error);
        return;
      }
      after?.();
    });
  };

  const loadPreview = () =>
    run(
      async () => {
        const result = await previewCampaignAction(campaign.id);
        if (result.preview) setPreview(result.preview);
        return result;
      },
      () => undefined,
    );

  const build = () =>
    run(
      async () => {
        const result = await buildQueueAction(campaign.id, []);
        if (result.preview) setPreview(result.preview);
        if (result.queued !== undefined) {
          toast(
            result.queued === 0
              ? "Nothing to queue — every record was held back"
              : `${result.queued.toLocaleString()} records queued`,
          );
        }
        return result;
      },
      () => router.refresh(),
    );

  const activate = async () => {
    // THE ONE CONFIRMATION ON THIS PAGE. Activating is the moment a real phone
    // starts ringing real people: the handsets poll for work and will begin
    // taking records within seconds, and there is no undo for a call that has
    // already been made. Pausing needs no confirmation because nothing is lost.
    const ok = await confirm({
      title: `Start ringing from “${campaign.name}”?`,
      body: `Phones on the floor will begin taking records from this campaign. ${
        campaign.queuedCount > 0
          ? `${campaign.queuedCount.toLocaleString()} records are queued.`
          : "The queue is empty, so nothing will be dialled until you build it."
      }`,
      confirmLabel: "Start the campaign",
    });
    if (!ok) return;
    run(
      async () => {
        const result = await activateCampaignAction(campaign.id);
        if (result.campaign) onChanged(result.campaign);
        return result;
      },
      () => toast("Campaign is live"),
    );
  };

  const pause = () =>
    run(
      async () => {
        const result = await pauseCampaignAction(campaign.id);
        if (result.campaign) onChanged(result.campaign);
        return result;
      },
      () => toast("Campaign paused"),
    );

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text">{campaign.name}</h3>
            <StatusChip tone={STATUS_TONE[campaign.status]}>{campaign.status}</StatusChip>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            {campaign.mode === "progressive"
              ? `Progressive — the next record arrives ${campaign.advanceDelaySec}s after the last call ends`
              : "Preview — the agent sees who they are about to ring and dials when ready"}
            {" · "}
            {campaign.maxAttempts} {campaign.maxAttempts === 1 ? "attempt" : "attempts"} per record
            {campaign.retryAfterHours > 0 ? `, ${campaign.retryAfterHours}h between tries` : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <MonoLabel>Queued</MonoLabel>
            <p className="text-sm font-semibold text-text">
              {campaign.queuedCount.toLocaleString()}
            </p>
          </div>
        </div>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
          disabled={pending}
          onClick={loadPreview}
        >
          {preview ? "Check again" : "Check who is dialable"}
        </button>
        {canEdit ? (
          <>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
              disabled={pending}
              onClick={build}
            >
              {campaign.queuedCount > 0 ? "Rebuild the queue" : "Build the queue"}
            </button>
            {campaign.status === "active" ? (
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
                disabled={pending}
                onClick={pause}
              >
                Pause
              </button>
            ) : campaign.status === "completed" ? null : (
              <button
                type="button"
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
                disabled={pending}
                // Wrapped rather than passed: `activate` awaits the confirm
                // dialog, and handing a promise-returning function straight to
                // onClick leaves the rejection unhandled.
                onClick={() => void activate()}
              >
                Start
              </button>
            )}
          </>
        ) : null}
      </div>

      {preview ? <PreviewPanel preview={preview} /> : null}
    </Card>
  );
}

/**
 * The preview, which is the centrepiece of the whole screen (doc 39 §11):
 *
 *   6,003 selected · 4,812 dialable · 902 no number · 211 on a DNC list · …
 *
 * ── WHY THE REASONS ARE LISTED IN DIAL_BLOCK_ORDER ─────────────────────────
 *
 * That array is a CONTRACT, not a display preference: it runs in descending
 * permanence, so the reason a record is shown is the most permanent one that
 * applies. Rendering these in count order would be more useful-looking and
 * would quietly teach a supervisor the wrong model - that a record blocked on
 * `quiet_hours` is a record with no number, when one clears at 9am and the
 * other never does. Permanence order is the honest order.
 *
 * Counts only, never numbers. A preview that could be asked for a thousand
 * E.164s is an export with a different name.
 */
function PreviewPanel({ preview }: { preview: DialPreviewCounts }) {
  const blocked: DialBlockReason[] = DIAL_BLOCK_ORDER.filter(
    (reason: DialBlockReason) => (preview.blocked[reason] ?? 0) > 0,
  );
  const blockedTotal = blocked.reduce(
    (sum: number, reason: DialBlockReason) => sum + (preview.blocked[reason] ?? 0),
    0,
  );

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <MonoLabel>Selected</MonoLabel>
          <p className="text-sm font-semibold text-text">{preview.selected.toLocaleString()}</p>
        </div>
        <div>
          <MonoLabel>Dialable</MonoLabel>
          <p className="text-sm font-semibold text-text">{preview.dialable.toLocaleString()}</p>
        </div>
        <div>
          <MonoLabel>Held back</MonoLabel>
          <p className="text-sm font-semibold text-text">{blockedTotal.toLocaleString()}</p>
        </div>
      </div>

      {preview.truncated ? (
        <p className="text-xs text-text-muted">
          This source selects more records than the preview reads, so these counts are the
          first slice of it rather than the whole. Narrow the source to see the real totals.
        </p>
      ) : null}

      {preview.unconfirmedOptOut > 0 ? (
        <p className="text-xs text-text-muted">
          {preview.unconfirmedOptOut.toLocaleString()} of the dialable records look like they
          may have asked us to stop, without saying so outright. They are still dialable and
          the agent is shown a banner — a person decides, not this page.
        </p>
      ) : null}

      {blocked.length > 0 ? (
        <Table caption="Why records in this campaign cannot be rung, most permanent reason first">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Held back because</TableHeaderCell>
              <TableHeaderCell className="text-right">Records</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {blocked.map((reason: DialBlockReason) => (
              <TableRow key={reason}>
                <TableCell>{DIAL_BLOCK_LABELS[reason]}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {(preview.blocked[reason] ?? 0).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
