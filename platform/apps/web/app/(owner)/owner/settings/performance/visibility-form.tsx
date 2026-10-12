"use client";

import { useState, useTransition } from "react";
import { Button, Card, Checkbox, Input, MonoLabel, Radio, RadioGroup } from "@aura/ui";
import { saveInsightsSettingsAction } from "./actions";

/**
 * §8.11's settings: who sees the leaderboard, demo mode, and the two
 * thresholds.
 *
 * ── LEADERBOARD VISIBILITY IS THE OWNER'S CALL, NOT A PRODUCT DEFAULT ───────
 *
 * A floor where everybody can see everybody's ranking is a different workplace
 * from one where they cannot. §16's default is "own rank only", which is the
 * conservative end, and this form is the only place it changes - the API
 * enforces it on three surfaces so a telecaller cannot reach the board by URL
 * when it is off.
 */
export function VisibilityForm({
  settings,
  today,
}: {
  settings: {
    leaderboardVisibility: "hidden" | "own_rank" | "full";
    demoMode: boolean;
    staleFeedHours: number;
    coverageFloor: number;
  };
  today: string;
}) {
  const [visibility, setVisibility] = useState(settings.leaderboardVisibility);
  const [demoMode, setDemoMode] = useState(settings.demoMode);
  const [staleHours, setStaleHours] = useState(String(settings.staleFeedHours));
  const [coverage, setCoverage] = useState(String(Math.round(settings.coverageFloor * 100)));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  function submit(): void {
    setError(null);
    setDone(false);
    start(async () => {
      const result = await saveInsightsSettingsAction({
        leaderboardVisibility: visibility,
        demoMode,
        staleFeedHours: Number(staleHours) || undefined,
        coverageFloor: Number(coverage) > 0 ? Number(coverage) / 100 : undefined,
      });
      if (result.error) setError(result.error);
      else setDone(true);
    });
  }

  return (
    <Card>
      <MonoLabel>Who sees what</MonoLabel>

      <RadioGroup
        legend="Leaderboard"
        hint="A floor where everybody sees everybody's ranking is a different workplace from one where they do not. This is your call, not ours."
        className="mt-3"
      >
          <Radio
            name="visibility"
            checked={visibility === "hidden"}
            onChange={() => setVisibility("hidden")}
            label="Off"
            description="Only owners and managers see any ranking."
          />
          <Radio
            name="visibility"
            checked={visibility === "own_rank"}
            onChange={() => setVisibility("own_rank")}
            label="Own rank only"
            description="A telecaller sees where they stand and no other row. The default."
          />
          <Radio
            name="visibility"
            checked={visibility === "full"}
            onChange={() => setVisibility("full")}
            label="Everyone sees everyone"
            description="The whole board, to the whole floor."
          />
      </RadioGroup>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="text-xs text-text-muted">
          Warn when nothing arrives for
          <div className="mt-0.5 flex items-center gap-2">
            <Input
              value={staleHours}
              inputMode="numeric"
              onChange={(e) => setStaleHours(e.target.value)}
              className="w-20"
            />
            <span className="text-sm text-text-muted">hours</span>
          </div>
        </label>
        <label className="text-xs text-text-muted">
          Hide a score below
          <div className="mt-0.5 flex items-center gap-2">
            <Input
              value={coverage}
              inputMode="numeric"
              onChange={(e) => setCoverage(e.target.value)}
              className="w-20"
            />
            <span className="text-sm text-text-muted">% measurable</span>
          </div>
        </label>
      </div>
      <p className="mt-1 text-xs text-text-muted">
        A score over too little of the set is not a score. Below this, the Performance screens show
        a dash and say how much could be measured.
      </p>

      <div className="mt-4">
        <Checkbox
          checked={demoMode}
          onChange={() => setDemoMode((v) => !v)}
          label="Show sample data while you set up"
          description="Every screen says so in words, and sample rows are kept separate from your own — they can never be mixed in or counted towards a KPI."
        />
      </div>

      {error ? <p className="mt-3 text-sm text-text">{error}</p> : null}
      {done ? <p className="mt-3 text-sm text-text-muted">Saved.</p> : null}

      <div className="mt-4">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-text-muted">Applies immediately, from {today}.</p>
    </Card>
  );
}
