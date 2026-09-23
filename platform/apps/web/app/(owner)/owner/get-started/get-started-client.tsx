"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, ChevronDown } from "lucide-react";
import { Button, Card, ErrorBanner, ProgressBar, StatusChip } from "@aura/ui";
import {
  SETUP_GROUP_LABELS,
  SetupGroup,
  requiredStepsLeftText,
  type SetupState,
  type SetupStepState,
} from "@aura/shared";
import { ReadinessPanel } from "@/components/readiness-panel";
import { SETUP_STEP_ICONS } from "@/components/setup-step-icons";
import {
  dismissGuideAction,
  reopenGuideAction,
  skipSetupStepAction,
  unskipSetupStepAction,
} from "../setup-actions";

/**
 * `?from=get-started` on every Set up link (doc 27 §7.2). The target page does
 * not read it - the breadcrumb ("Home > Get started") and the sidebar widget
 * are the way back - it only lets a later reader of the access log tell a
 * guided visit from a browsing one. Deliberately NOT handled by two dozen pages.
 */
function withFrom(href: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}from=get-started`;
}

export function GetStarted({
  setup,
  isOwner,
  dismissed,
}: {
  setup: SetupState;
  isOwner: boolean;
  /** The owner hid the guide (guide_dismissed_at). The page stays reachable. */
  dismissed: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  const run = (id: string, action: () => Promise<{ error?: string }>) => {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      setBusyId(null);
    });
  };

  const counted = setup.steps.filter((s) => !s.skipped);
  const skipped = setup.steps.filter((s) => s.skipped);
  const requiredLeft = setup.requiredTotal - setup.requiredDone;
  const percent = setup.total > 0 ? (setup.done / setup.total) * 100 : 100;

  return (
    <>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-2xl font-semibold text-text">
            {setup.done} of {setup.total} done
          </p>
          {requiredLeft > 0 ? <p className="text-sm text-text-muted">{requiredStepsLeftText(setup)}</p> : null}
        </div>
        <ProgressBar percent={percent} />
        {setup.guideComplete ? (
          <p className="text-sm text-text-muted">Every step that applies to your workspace is done or skipped.</p>
        ) : null}
      </Card>

      <ReadinessPanel lines={setup.readiness} />

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {SetupGroup.options.map((group) => {
        const rows = counted.filter((s) => s.group === group);
        if (rows.length === 0) return null;
        const done = rows.filter((s) => s.done).length;
        return (
          <section key={group} aria-labelledby={`group-${group}`} className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id={`group-${group}`} className="text-base font-semibold text-text">
                {SETUP_GROUP_LABELS[group]}
              </h2>
              <span className="text-sm text-text-muted">
                {done}/{rows.length}
              </span>
            </div>
            <Card className="p-0">
              <ul className="divide-y divide-border">
                {rows.map((step) => (
                  <StepRow
                    key={step.id}
                    step={step}
                    busy={pending && busyId === step.id}
                    onSkip={() => run(step.id, () => skipSetupStepAction(step.id))}
                  />
                ))}
              </ul>
            </Card>
          </section>
        );
      })}

      {skipped.length > 0 ? (
        <section className="space-y-2">
          <button
            type="button"
            onClick={() => setShowSkipped((v) => !v)}
            aria-expanded={showSkipped}
            className="flex items-center gap-1.5 text-sm font-semibold text-text"
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform duration-150 ${showSkipped ? "" : "-rotate-90"}`}
              aria-hidden="true"
            />
            Skipped ({skipped.length})
          </button>
          {showSkipped ? (
            <Card className="p-0">
              <ul className="divide-y divide-border">
                {skipped.map((step) => {
                  const Icon = SETUP_STEP_ICONS[step.id];
                  return (
                    <li key={step.id} className="flex items-center gap-3 px-5 py-3">
                      <Icon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-sm text-text-muted">{step.label}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        loading={pending && busyId === step.id}
                        onClick={() => run(step.id, () => unskipSetupStepAction(step.id))}
                      >
                        Undo
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
        </section>
      ) : null}

      <div className="border-t border-border pt-4 text-sm text-text-muted">
        {dismissed ? (
          isOwner ? (
            <p>
              This guide is hidden from the sidebar.{" "}
              <button
                type="button"
                disabled={pending}
                onClick={() => run("guide", reopenGuideAction)}
                className="font-medium text-text underline underline-offset-2"
              >
                Show it again
              </button>
            </p>
          ) : (
            <p>This guide is hidden from the sidebar. Only an owner can bring it back.</p>
          )
        ) : isOwner ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run("guide", dismissGuideAction)}
            className="font-medium text-text underline underline-offset-2"
          >
            Hide this guide
          </button>
        ) : (
          <p>Only an owner can hide this guide.</p>
        )}
      </div>
    </>
  );
}

function StepRow({ step, busy, onSkip }: { step: SetupStepState; busy: boolean; onSkip: () => void }) {
  const Icon = SETUP_STEP_ICONS[step.id];
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          aria-hidden
          className={
            step.done
              ? "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success text-bg"
              : "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-text"
          }
        >
          {step.done ? <Check className="h-4 w-4" /> : <Icon className="h-5 w-5" />}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                step.done ? "text-sm font-semibold text-text-muted line-through" : "text-sm font-semibold text-text"
              }
            >
              {step.label}
            </span>
            {step.done ? <span className="sr-only">(done)</span> : null}
            {step.required && !step.done ? <StatusChip tone="danger">Required</StatusChip> : null}
            {!step.done && !step.canDo ? <StatusChip tone="muted">Owner only</StatusChip> : null}
          </div>
          <p className="mt-1 text-sm text-text-muted">{step.blurb}</p>
        </div>
      </div>
      {!step.done ? (
        <div className="flex shrink-0 items-center gap-2 pl-9 sm:pl-0">
          {step.canDo ? (
            <Link
              href={withFrom(step.href)}
              className="inline-flex h-8 items-center rounded-full border border-border-strong px-3 text-sm font-medium text-text hover:bg-surface-hover"
            >
              Set up
            </Link>
          ) : null}
          {!step.required ? (
            <Button type="button" variant="ghost" size="sm" loading={busy} onClick={onSkip}>
              Skip
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
