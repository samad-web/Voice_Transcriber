"use client";

import { useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { BrutalButton, Card, Input, Select, useAlert, useToast } from "@aura/ui";
import { updatePolicyAction } from "./actions";

export function PolicyForm({
  orgId,
  initial,
}: {
  orgId: string;
  initial: {
    consent_policy: string;
    on_consent_failure: string;
    retention_days: number;
    store_full_number?: boolean;
  };
}) {
  const [consentPolicy, setConsentPolicy] = useState(initial.consent_policy);
  const [onConsentFailure, setOnConsentFailure] = useState(initial.on_consent_failure);
  const [retentionDays, setRetentionDays] = useState(String(initial.retention_days));
  const [storeFullNumber, setStoreFullNumber] = useState(initial.store_full_number ?? false);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const save = () =>
    startTransition(async () => {
      const res = await updatePolicyAction({
        orgId,
        consentPolicy,
        onConsentFailure,
        retentionDays: Number(retentionDays),
        storeFullNumber,
      });
      if (res.error) {
        await alert({
          title: "Couldn't apply the policy",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      toast("Policy applied - devices bumped.");
    });

  return (
    <Card elevated className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" />
        <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
          Consent &amp; Retention Policy
        </h4>
      </div>
      <p className="text-xs text-neutral-500 font-sans font-medium">
        Applies to every handset enrolled in this instance - saving bumps their config version.
      </p>

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          Consent Regime
        </label>
        <Select value={consentPolicy} onChange={(e) => setConsentPolicy(e.target.value)}>
          <option value="none">Bypass (allowed jurisdictions)</option>
          <option value="tone">Tone beep</option>
          <option value="tone_and_tts">Tone + TTS announcement</option>
          <option value="prohibited">Prohibited (fleet lockout)</option>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          On Consent Failure
        </label>
        <Select value={onConsentFailure} onChange={(e) => setOnConsentFailure(e.target.value)}>
          <option value="do_not_record">Do not record</option>
          <option value="record_and_flag">Record &amp; flag</option>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          Retention (days)
        </label>
        {/* Was wearing `selectClass` - the uppercase-bold *dropdown* styling on a
            numeric field. Not a dropdown, so it takes Input, which shares the
            same CONTROL_BASE edge the Select above it now uses. */}
        <Input
          type="number"
          min={1}
          max={3650}
          value={retentionDays}
          onChange={(e) => setRetentionDays(e.target.value)}
        />
      </div>

      <label className="flex items-start gap-2.5 cursor-pointer border-2 border-neutral-200 p-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-black shrink-0"
          checked={storeFullNumber}
          onChange={(e) => setStoreFullNumber(e.target.checked)}
        />
        <span className="text-xs font-sans text-neutral-700 leading-relaxed">
          <span className="font-display font-bold uppercase text-black block text-xs">
            Store full phone numbers
          </span>
          Off by default: only a 5-digit prefix, the last 3 digits and a hash are kept, which
          cannot be dialled. Turn on so leads pushed to this customer&apos;s CRM are callable.
          Applies to calls recorded from now on.
        </span>
      </label>

      <div className="flex items-center gap-3">
        <BrutalButton shadow disabled={pending} onClick={save}>
          {pending ? "APPLYING..." : "APPLY POLICY"}
        </BrutalButton>
      </div>
    </Card>
  );
}
