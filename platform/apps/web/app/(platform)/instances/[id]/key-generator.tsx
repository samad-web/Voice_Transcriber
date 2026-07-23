"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, KeyRound } from "lucide-react";
import { BrutalButton, Card } from "@aura/ui";
import { EnrollmentCredentials, type Credentials } from "../enrollment-credentials";
import { mintKeyAction } from "./actions";
import { inputClass } from "@/lib/form";

/** Issue an additional enrollment key when the customer onboards more handsets. */
export function KeyGenerator({
  orgId,
  instanceId,
  instanceName,
}: {
  orgId: string;
  instanceId: string;
  instanceName: string;
}) {
  const [serverUrl, setServerUrl] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState(15);
  const [maxUses, setMaxUses] = useState(1);
  const [result, setResult] = useState<(Credentials & { error?: string }) | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      setResult(await mintKeyAction({ orgId, instanceId, ttlMinutes, maxUses }));
    });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card shadow className="space-y-4">
        <div>
          <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
            Issue Enrollment Key
          </h4>
          <p className="text-xs text-neutral-400 font-sans font-medium mt-0.5">
            Enrolls new handsets into {instanceName}. Shown exactly once.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
            Device Server URL <span className="text-neutral-400">(optional — put in the QR)</span>
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

        <BrutalButton className="w-full" shadow disabled={pending} onClick={submit}>
          <KeyRound className="h-4 w-4" />
          {pending ? "GENERATING..." : "GENERATE KEY"}
        </BrutalButton>

        {result?.error ? (
          <div className="border-2 border-red-600 bg-red-50 p-3.5 flex gap-2.5 items-start">
            <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700 font-sans font-bold">{result.error}</p>
          </div>
        ) : null}
      </Card>

      {result?.adminKey ? (
        <EnrollmentCredentials
          result={{ ...result, instanceName }}
          serverUrl={serverUrl}
          title="New Key — shown once"
        />
      ) : (
        <Card className="flex items-center justify-center min-h-48">
          <p className="text-xs font-mono font-bold uppercase text-neutral-400">
            Generated key appears here — once
          </p>
        </Card>
      )}
    </div>
  );
}
