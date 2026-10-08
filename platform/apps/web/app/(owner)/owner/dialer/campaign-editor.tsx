"use client";

import { useState, useTransition } from "react";
import { Card, ErrorBanner, MonoLabel, useToast } from "@aura/ui";
import type { DialCampaignView } from "@aura/shared/dist/dialer";
import type { SavedView } from "@/lib/list-views";
import { createCampaignAction } from "./actions";

const FIELD =
  "rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text disabled:opacity-60";

/**
 * Create a campaign (Build docs/40 §B1).
 *
 * ── THE SOURCE IS A SAVED VIEW OR EVERYONE ─────────────────────────────────
 *
 * 0159 allows three source kinds - `saved_view`, `board` and `filter` - and this
 * form offers two of them: a saved view, or `filter` with an empty filter, which
 * means every lead in the workspace. Boards are left out of the FIRST version
 * deliberately rather than accidentally: a board source needs a board picker
 * whose options are per-workspace, and offering a half-populated one is worse
 * than offering a saved view, which is how a supervisor already describes the
 * list they have in mind ("my hot Chennai leads"). The API accepts all three,
 * so adding boards later is a picker and no new endpoint.
 *
 * ── maxAttempts IS NOT THE ONLY CEILING, AND SAYS SO ───────────────────────
 *
 * The field below is per RECORD. The per-PERSON daily ceiling lives in the dial
 * policy card directly above this one and applies across every campaign at
 * once - and it ships uncapped. Doc 39 agreed to that default on the condition
 * that the two numbers are read together, which is why this form carries a line
 * pointing at the other one instead of standing alone on a tidy settings page.
 */
export function CampaignEditor({
  savedViews,
  workspaceId,
  canCreate,
  onCreated,
}: {
  savedViews: SavedView[];
  workspaceId: string | null;
  canCreate: boolean;
  onCreated: (campaign: DialCampaignView) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [source, setSource] = useState<string>("all");
  const [mode, setMode] = useState<"preview" | "progressive">("preview");
  const [priority, setPriority] = useState("temperature");
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [retryAfterHours, setRetryAfterHours] = useState(24);

  if (!canCreate) return null;

  if (!workspaceId) {
    // A campaign belongs to a workspace, and `workspaceId` is nullable on the
    // membership. Said plainly rather than rendering a form whose submit would
    // fail a uuid check with "Invalid uuid" - which tells the reader nothing
    // about what is actually missing.
    return (
      <Card>
        <p className="text-sm text-text-muted">
          This account is not attached to a workspace yet, so there is nowhere to put a
          campaign. An owner can set that up under Team &amp; permissions.
        </p>
      </Card>
    );
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90"
          onClick={() => setOpen(true)}
        >
          New campaign
        </button>
      </div>
    );
  }

  const submit = () => {
    setError(null);
    const view = savedViews.find((v) => v.id === source);
    startTransition(async () => {
      const result = await createCampaignAction({
        name,
        workspaceId,
        mode,
        priority,
        maxAttempts,
        retryAfterHours,
        // `saved_view` carries the view's id; "everyone" is `filter` with an
        // empty filter, which is what 0159 means by a filter source and needs
        // no ref at all.
        ...(view
          ? { sourceKind: "saved_view", sourceRef: view.id }
          : { sourceKind: "filter", sourceFilter: {} }),
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.campaign) onCreated(result.campaign);
      toast(`“${name}” created as a draft`);
      setOpen(false);
      setName("");
    });
  };

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">New campaign</h3>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          Created as a draft. Nothing is dialled until you build the queue and start it.
        </p>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <MonoLabel>Name</MonoLabel>
          <input
            className={`${FIELD} w-full`}
            value={name}
            disabled={pending}
            placeholder="e.g. October winbacks"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Who to ring</MonoLabel>
          <select
            className={`${FIELD} w-full`}
            value={source}
            disabled={pending}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="all">Everyone in this workspace</option>
            {savedViews.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
          <span className="block text-xs text-text-muted">
            {savedViews.length === 0
              ? "Save a view on the Leads page to ring a narrower list."
              : "A saved view from the Leads page, or everyone."}
          </span>
        </label>

        <label className="space-y-1.5">
          <MonoLabel>How the agent works it</MonoLabel>
          <select
            className={`${FIELD} w-full`}
            value={mode}
            disabled={pending}
            onChange={(e) => setMode(e.target.value === "progressive" ? "progressive" : "preview")}
          >
            <option value="preview">Preview — they see who it is, then dial</option>
            <option value="progressive">Progressive — the next one arrives on its own</option>
          </select>
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Order</MonoLabel>
          <select
            className={`${FIELD} w-full`}
            value={priority}
            disabled={pending}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="temperature">Hottest first</option>
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
            <option value="value">Highest value first</option>
          </select>
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Attempts per record</MonoLabel>
          <input
            type="number"
            min={1}
            max={10}
            className={`${FIELD} w-full`}
            value={maxAttempts}
            disabled={pending}
            onChange={(e) => setMaxAttempts(Number(e.target.value))}
          />
          {/* The pointer to the OTHER ceiling. This is the line doc 39's
              uncapped default was agreed on the strength of. */}
          <span className="block text-xs text-text-muted">
            How many times one record may be tried. The daily limit per PERSON is in Dial
            policy above and counts across every campaign — the same human can be on two
            lists.
          </span>
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Hours between tries</MonoLabel>
          <input
            type="number"
            min={0}
            max={720}
            className={`${FIELD} w-full`}
            value={retryAfterHours}
            disabled={pending}
            onChange={(e) => setRetryAfterHours(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="flex gap-2 border-t border-border pt-3">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
          disabled={pending || name.trim().length === 0}
          onClick={submit}
        >
          Create draft
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </Card>
  );
}
