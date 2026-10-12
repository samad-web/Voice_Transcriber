"use client";

import { useState, useTransition } from "react";
import { Button, Card, Input, MonoLabel, Select } from "@aura/ui";
import { requestPlanChangeAction, startTrialAction } from "./actions";

/**
 * What an owner can actually do about their plan.
 *
 * ── THE WORDING IS THE FEATURE ──────────────────────────────────────────────
 *
 * §9.7 rules out countdown pressure, hidden costs and dark patterns, and the
 * practical consequence is in the copy: "Talk to us" rather than "Upgrade
 * now", a plain statement of what a move down locks, and a trial described as
 * reverting on its own because it does.
 *
 * One open request at a time, because the API keeps one (a partial unique
 * index) - a second ask updates the first rather than queueing a row an
 * operator cannot tell apart from the last one.
 */
export function PlanActions({
  current,
  plans,
  openRequest,
  trialsTaken,
}: {
  current: {
    planKey: string | null;
    trialPlanKey: string | null;
    pendingPlanKey: string | null;
  };
  plans: { key: string; name: string }[];
  openRequest: { kind: string; plan_key: string | null; created_at: string } | null;
  trialsTaken: string[];
}) {
  const currentIndex = plans.findIndex((p) => p.key === current.planKey);
  const higher = currentIndex < 0 ? plans : plans.slice(currentIndex + 1);
  const lower = currentIndex <= 0 ? [] : plans.slice(0, currentIndex);

  const [wanted, setWanted] = useState(higher[0]?.key ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const trialable = higher.filter((p) => !trialsTaken.includes(p.key));

  function ask(kind: "upgrade" | "downgrade" | "cancel" | "demo", planKey?: string): void {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await requestPlanChangeAction({ kind, planKey, note: note || undefined });
      if (result.error) setError(result.error);
      else {
        setDone(
          kind === "demo"
            ? "Asked for a demo. We will be in touch."
            : "Sent. We will confirm before anything changes.",
        );
      }
    });
  }

  function trial(planKey: string): void {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await startTrialAction(planKey);
      if (result.error) setError(result.error);
      else setDone("Trial started. It ends on its own in 14 days — nothing is charged.");
    });
  }

  return (
    <Card>
      <MonoLabel>Change your plan</MonoLabel>

      {openRequest ? (
        <p className="mt-1 text-sm text-text-muted">
          You have asked to {openRequest.kind}
          {openRequest.plan_key ? ` to ${openRequest.plan_key}` : ""}. We will confirm before
          anything changes — asking again just updates that request.
        </p>
      ) : null}

      {higher.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-text-muted">
            Move up to
            <Select
              value={wanted}
              onChange={(e) => setWanted(e.target.value)}
              className="mt-0.5 w-44"
            >
              {higher.map((plan) => (
                <option key={plan.key} value={plan.key}>
                  {plan.name}
                </option>
              ))}
            </Select>
          </label>
          <Button onClick={() => ask("upgrade", wanted)} disabled={pending || !wanted}>
            Talk to us
          </Button>
          {trialable.some((p) => p.key === wanted) && !current.trialPlanKey ? (
            <Button variant="secondary" onClick={() => trial(wanted)} disabled={pending}>
              Try it for 14 days
            </Button>
          ) : null}
        </div>
      ) : null}

      <label className="mt-3 block text-xs text-text-muted">
        Anything we should know
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="We are adding 30 telecallers in January"
          className="mt-0.5"
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        {lower.length > 0 ? (
          <button
            type="button"
            onClick={() => ask("downgrade", lower[lower.length - 1].key)}
            disabled={pending}
            className="text-text-muted underline underline-offset-2 hover:text-text"
          >
            Move down to {lower[lower.length - 1].name}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => ask("demo")}
          disabled={pending}
          className="text-text-muted underline underline-offset-2 hover:text-text"
        >
          Request a demo of the CRM and AI
        </button>
        <button
          type="button"
          onClick={() => ask("cancel")}
          disabled={pending}
          className="text-text-muted underline underline-offset-2 hover:text-text"
        >
          Cancel
        </button>
      </div>

      <p className="mt-3 text-xs text-text-muted">
        A move down takes effect at the end of the period, and we will show you exactly what gets
        locked first. Your data is kept either way — a lower plan limits what is displayed, never
        what is stored.
      </p>

      {error ? <p className="mt-3 text-sm text-text">{error}</p> : null}
      {done ? <p className="mt-3 text-sm text-text-muted">{done}</p> : null}
    </Card>
  );
}
