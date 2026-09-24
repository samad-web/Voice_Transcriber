"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight, Building2 } from "lucide-react";
import { BrutalButton, Card, MonoLabel, Select, useAlert } from "@aura/ui";
import { inputClass } from "@/lib/form";
import { EnrollmentCredentials } from "../enrollment-credentials";
import { createTenantAction, type ProvisionResult } from "./actions";

const CONSENT_POLICIES = [
  { value: "tone", label: "Announcement tone" },
  { value: "tone_and_tts", label: "Tone + spoken notice" },
  { value: "none", label: "No announcement" },
  { value: "prohibited", label: "Recording disabled" },
];

export function InstanceForm() {
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [consentPolicy, setConsentPolicy] = useState("tone");
  const [retentionDays, setRetentionDays] = useState(90);
  const [ttlMinutes, setTtlMinutes] = useState(15);
  const [maxUses, setMaxUses] = useState(1);
  const [enableCrm, setEnableCrm] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const submit = () => {
    startTransition(async () => {
      const provisioned = await createTenantAction({
        name,
        consentPolicy,
        retentionDays,
        ttlMinutes,
        maxUses,
        enableCrm,
      });
      if (provisioned.error) {
        await alert({
          title: "Couldn't create the instance",
          body: provisioned.error,
          tone: "danger",
        });
        return;
      }
      setResult(provisioned);
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card elevated className="space-y-4">
        <div>
          <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
            New Customer Instance
          </h4>
          <p className="text-xs text-text-muted font-sans font-medium mt-0.5">
            Creates an isolated tenant for this company, plus its first enrollment key. The key is
            shown exactly once.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
            Company Name
          </label>
          <input
            className={inputClass}
            placeholder="e.g. Acme Financial Services"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
            Device Server URL <span className="text-text-muted">(optional - put in the QR)</span>
          </label>
          <input
            className={inputClass}
            placeholder="e.g. https://xxxx.ngrok-free.dev"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Consent Policy
            </label>
            <Select value={consentPolicy} onChange={(e) => setConsentPolicy(e.target.value)}>
              {CONSENT_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Retention (days)
            </label>
            <input
              type="number"
              min={1}
              max={3650}
              className={inputClass}
              value={retentionDays}
              onChange={(e) => setRetentionDays(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Key TTL (minutes)
            </label>
            <input
              type="number"
              min={5}
              max={1440}
              className={inputClass}
              value={ttlMinutes}
              onChange={(e) => setTtlMinutes(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Max Enrollments
            </label>
            <input
              type="number"
              min={1}
              max={500}
              className={inputClass}
              value={maxUses}
              onChange={(e) => setMaxUses(Number(e.target.value))}
            />
          </div>
        </div>

        <label className="flex items-start gap-2.5 border-2 border-border-strong bg-surface p-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={enableCrm}
            onChange={(e) => setEnableCrm(e.target.checked)}
          />
          <span>
            <span className="block text-xs font-mono uppercase tracking-wider font-bold text-black">
              Enable CRM
            </span>
            <span className="block text-[11px] text-text-muted font-sans mt-0.5">
              Contacts, Accounts, Deals, pipelines and roles for this client. Off by default - every
              instance gets call recording and transcription regardless; this adds the CRM on top.
              Can be turned on or off later from the instance page.
            </span>
          </span>
        </label>

        <BrutalButton
          className="w-full"
          shadow
          disabled={pending || name.trim().length === 0}
          onClick={submit}
        >
          <Building2 className="h-4 w-4" />
          {pending ? "PROVISIONING..." : "CREATE INSTANCE"}
        </BrutalButton>
      </Card>

      {result?.adminKey ? (
        <div className="space-y-4">
          <EnrollmentCredentials result={result} serverUrl={serverUrl} />
          <p className="text-xs text-text-muted font-sans font-medium">
            CRM: {result.enabledModules?.includes("crm") ? "enabled" : "not enabled"} for this
            instance.
          </p>
          <Link href={`/instances/${result.orgId}`}>
            <BrutalButton variant="secondary" className="w-full">
              Open {result.instanceName}
              <ArrowRight className="h-4 w-4" />
            </BrutalButton>
          </Link>
        </div>
      ) : (
        <Card className="flex flex-col items-center justify-center min-h-48 gap-2">
          <MonoLabel>Provisioned credentials appear here - once</MonoLabel>
          <p className="text-[11px] text-text-muted font-sans max-w-xs text-center">
            The company gets its own org, workspace and instance. Nothing is shared with your other
            customers.
          </p>
        </Card>
      )}
    </div>
  );
}
