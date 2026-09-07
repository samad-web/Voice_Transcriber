"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, MonoLabel, StatusChip, useAlert } from "@aura/ui";
import { setFeatureAction } from "./actions";
import type { FeatureRow } from "./page";

interface Group {
  key: string;
  label: string;
  features: FeatureRow[];
}

/**
 * The switchboard.
 *
 * ── ONE SWITCH SAVES ONE SWITCH ───────────────────────────────────────────
 *
 * Each toggle writes immediately and the page refreshes, rather than a board
 * of thirty checkboxes behind a Save button. Two reasons.
 *
 * A dependency makes the board's state change in ways the person did not
 * click: switching off Products blocks Quotations and Invoices too. That has
 * to be visible as it happens, not discovered after saving - which means the
 * server has to have resolved it, which means a round trip anyway.
 *
 * And the API's PUT is deliberately partial for this: two owners on this page
 * at once each send one key, so the second save cannot silently revert the
 * first's unrelated change. A whole-board submit would do exactly that.
 */
export function FeatureBoard({ groups, canEdit }: { groups: Group[]; canEdit: boolean }) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <Card key={group.key} className="space-y-3">
          <MonoLabel>{group.label}</MonoLabel>
          <ul className="divide-y divide-border">
            {group.features.map((feature) => (
              <FeatureItem key={feature.key} feature={feature} canEdit={canEdit} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function FeatureItem({ feature, canEdit }: { feature: FeatureRow; canEdit: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const alert = useAlert();

  const on = optimistic ?? feature.state === "on";
  // Only a feature that is on or off is the client's to change. `blocked` and
  // `unavailable` are answers about something else, and offering a switch that
  // cannot move is worse than offering no switch at all.
  const switchable = canEdit && !feature.locked && (feature.state === "on" || feature.state === "off");

  const toggle = () => {
    const next = !on;
    setOptimistic(next);
    startTransition(async () => {
      const res = await setFeatureAction(feature.key, next);
      if (res.error) {
        setOptimistic(null);
        await alert({ title: `Couldn't change ${feature.label}`, body: res.error, tone: "danger" });
        return;
      }
      // The server decides the resolved state - a dependency may have taken
      // other features down with this one - so the page is re-read rather than
      // patched in place.
      setOptimistic(null);
      router.refresh();
    });
  };

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text">{feature.label}</span>
          {feature.locked ? <StatusChip tone="muted">always on</StatusChip> : null}
          {feature.state === "unavailable" ? (
            <StatusChip tone="outline">not in your plan</StatusChip>
          ) : null}
          {feature.state === "blocked" ? (
            <StatusChip tone="outline">needs {feature.blockedBy}</StatusChip>
          ) : null}
        </div>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-text-muted">{feature.blurb}</p>
        {feature.state === "unavailable" ? (
          <p className="mt-1 text-xs text-text-muted">
            Ask your provider to add it — it is not something this console can switch on.
          </p>
        ) : null}
        {feature.state === "blocked" && feature.blockedBy ? (
          <p className="mt-1 text-xs text-text-muted">
            Switch <strong className="font-medium text-text">{feature.blockedBy}</strong> back on
            first — this one has nothing to work with otherwise.
          </p>
        ) : null}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={feature.label}
        disabled={!switchable || pending}
        onClick={toggle}
        className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-150 ${
          on ? "border-border-strong bg-text" : "border-border bg-bg-subtle"
        } ${switchable ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
      >
        <span
          className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-surface transition-all duration-150 ${
            on ? "left-[1.375rem]" : "left-0.5"
          }`}
        />
      </button>
    </li>
  );
}
