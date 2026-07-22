"use client";

import { useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { BrutalButton, Card } from "@aura/ui";
import { updatePolicyAction } from "./actions";

const selectClass =
  "w-full p-2.5 border-2 border-black bg-neutral-50 rounded-none text-xs text-black font-bold uppercase focus:outline-none";

export function PolicyForm({
  orgId,
  initial,
}: {
  orgId: string;
  initial: { consent_policy: string; on_consent_failure: string; retention_days: number };
}) {
  const [consentPolicy, setConsentPolicy] = useState(initial.consent_policy);
  const [onConsentFailure, setOnConsentFailure] = useState(initial.on_consent_failure);
  const [retentionDays, setRetentionDays] = useState(String(initial.retention_days));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setError(null);
      const res = await updatePolicyAction({
        orgId,
        consentPolicy,
        onConsentFailure,
        retentionDays: Number(retentionDays),
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });

  return (
    <Card shadow className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" />
        <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
          Consent &amp; Retention Policy
        </h4>
      </div>
      <p className="text-xs text-neutral-500 font-sans font-medium">
        Applies to every handset enrolled in this instance — saving bumps their config version.
      </p>

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          Consent Regime
        </label>
        <select
          className={selectClass}
          value={consentPolicy}
          onChange={(e) => setConsentPolicy(e.target.value)}
        >
          <option value="none">Bypass (allowed jurisdictions)</option>
          <option value="tone">Tone beep</option>
          <option value="tone_and_tts">Tone + TTS announcement</option>
          <option value="prohibited">Prohibited (fleet lockout)</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          On Consent Failure
        </label>
        <select
          className={selectClass}
          value={onConsentFailure}
          onChange={(e) => setOnConsentFailure(e.target.value)}
        >
          <option value="do_not_record">Do not record</option>
          <option value="record_and_flag">Record &amp; flag</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          Retention (days)
        </label>
        <input
          type="number"
          min={1}
          max={3650}
          className={selectClass}
          value={retentionDays}
          onChange={(e) => setRetentionDays(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-3">
        <BrutalButton shadow disabled={pending} onClick={save}>
          {pending ? "APPLYING..." : "APPLY POLICY"}
        </BrutalButton>
        {saved ? (
          <span className="text-xs font-mono font-bold uppercase text-black">
            Applied · devices bumped
          </span>
        ) : null}
        {error ? (
          <span className="text-xs font-mono font-bold uppercase text-red-700">{error}</span>
        ) : null}
      </div>
    </Card>
  );
}
