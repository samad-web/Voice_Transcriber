"use client";

import { useState, useTransition } from "react";
import { FlaskConical, Play } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { testAgentAction, type AgentTestResult } from "./actions";
import type { AgentRow } from "./agent-studio";

const inputClass =
  "w-full p-2.5 border-2 border-black bg-neutral-50 rounded-none text-sm font-sans text-black focus:outline-none";

export function AgentSandbox({ agents }: { agents: AgentRow[] }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [callId, setCallId] = useState("");
  const [version, setVersion] = useState("");
  const [result, setResult] = useState<AgentTestResult | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      setResult(null);
      const res = await testAgentAction({
        agentId,
        callId: callId.trim(),
        version: version.trim() ? Number(version) : undefined,
      });
      setResult(res);
    });

  const validationTone =
    result?.validationStatus === "valid" || result?.validationStatus === "passed"
      ? "solid"
      : "danger";

  return (
    <Card shadow className="space-y-4">
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4" />
        <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
          Sandbox — Test Against a Stored Call
        </h4>
      </div>
      <p className="text-xs text-neutral-400 font-sans font-medium">
        Run an agent version against a real transcript to preview the extracted JSON and validation
        before activating it.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
            Agent
          </label>
          <select className={inputClass} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.length === 0 ? <option value="">No agents</option> : null}
            {agents.map((a) => (
              <option key={`${a.id}-${a.version}`} value={a.id}>
                {a.name} (v{a.version})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
            Call ID
          </label>
          <input
            className={`${inputClass} font-mono`}
            placeholder="uuid of a stored call"
            value={callId}
            onChange={(e) => setCallId(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
            Version (optional)
          </label>
          <input
            type="number"
            min={1}
            className={`${inputClass} font-mono`}
            placeholder="active"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />
        </div>
      </div>

      <BrutalButton
        shadow
        className="w-full"
        disabled={pending || !agentId || !callId.trim()}
        onClick={run}
      >
        <Play className="h-4 w-4" />
        {pending ? "RUNNING AGENT…" : "RUN TEST"}
      </BrutalButton>

      {result?.error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {result.error}
        </p>
      ) : null}

      {result && !result.error ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            {result.validationStatus ? (
              <StatusChip tone={validationTone}>validation: {result.validationStatus}</StatusChip>
            ) : null}
            {result.agentVersion != null ? (
              <StatusChip tone="muted">v{result.agentVersion}</StatusChip>
            ) : null}
            {result.provider ? <StatusChip tone="outline">{result.provider}</StatusChip> : null}
            {result.model ? <StatusChip tone="outline">{result.model}</StatusChip> : null}
            {result.tokensIn != null || result.tokensOut != null ? (
              <StatusChip tone="outline">
                {result.tokensIn ?? 0} in / {result.tokensOut ?? 0} out
              </StatusChip>
            ) : null}
          </div>

          <div>
            <MonoLabel className="mb-2">Agent Output</MonoLabel>
            <div className="bg-black rounded-none p-4 text-[10px] font-mono text-green-400 overflow-x-auto max-h-72 overflow-y-auto border-2 border-black">
              <pre>{JSON.stringify(result.output ?? null, null, 2)}</pre>
            </div>
          </div>

          {result.validationErrors &&
          (Array.isArray(result.validationErrors)
            ? result.validationErrors.length > 0
            : true) ? (
            <div>
              <MonoLabel className="mb-2">Validation Errors</MonoLabel>
              <div className="bg-black rounded-none p-4 text-[10px] font-mono text-red-400 overflow-x-auto max-h-48 overflow-y-auto border-2 border-black">
                <pre>{JSON.stringify(result.validationErrors, null, 2)}</pre>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
