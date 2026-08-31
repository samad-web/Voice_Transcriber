"use client";

import { useState, useTransition } from "react";
import { Copy, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { compileToJsonSchema } from "@aura/shared";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { inputClass, selectClass } from "@/lib/form";
import {
  activateAgentAction,
  createAgentAction,
  generateAgentAction,
  type AgentFieldInput,
} from "./actions";

export interface AgentRow {
  id: string;
  name: string;
  version: number;
  is_active: boolean;
  system_prompt: string;
  field_schema: { fields: AgentFieldInput[] };
  created_at: string;
}

const FIELD_TYPES = ["string", "number", "boolean", "enum", "datetime", "string[]"] as const;

const EMPTY_FIELD: AgentFieldInput = { key: "", type: "string", description: "", required: false };

export function AgentStudio({
  agents,
  orgId,
  workspaces,
}: {
  agents: AgentRow[];
  orgId?: string;
  /** The tenant's own workspaces — an agent must be created in one of these,
   *  never in the environment's DEV_WORKSPACE_ID. */
  workspaces: Array<{ id: string; name: string }>;
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(
    "You are an expert call analyst. Extract the requested fields strictly from the transcript.",
  );
  const [fields, setFields] = useState<AgentFieldInput[]>([
    { key: "intent", type: "enum", description: "Buyer intent", required: true, enumValues: ["hot", "warm", "cold"] },
  ]);
  const [activate, setActivate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // "Start from" (clone) and "Describe with AI" (generate) both just
  // prefill name/systemPrompt/fields above — the create flow below is
  // unchanged regardless of how the form got filled in.
  const [baseKey, setBaseKey] = useState("");
  const [description, setDescription] = useState("");
  const [generateError, setGenerateError] = useState<string | null>(null);

  const updateField = (i: number, patch: Partial<AgentFieldInput>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  const applyBase = (key: string) => {
    setBaseKey(key);
    const base = agents.find((a) => `${a.id}-${a.version}` === key);
    if (!base) return;
    setName(`${base.name} (copy)`);
    setSystemPrompt(base.system_prompt);
    setFields(base.field_schema.fields.map((f) => ({ ...f })));
  };

  const generate = () => {
    if (!description.trim()) return;
    setGenerateError(null);
    setError(null);
    startTransition(async () => {
      const base = agents.find((a) => `${a.id}-${a.version}` === baseKey);
      const res = await generateAgentAction({
        description,
        baseAgentId: base?.id,
        baseVersion: base?.version,
        orgId,
      });
      if (res.error) {
        setGenerateError(res.error);
        return;
      }
      if (res.name) setName(res.name);
      if (res.systemPrompt) setSystemPrompt(res.systemPrompt);
      if (res.fields) setFields(res.fields);
    });
  };

  const submit = () =>
    startTransition(async () => {
      const clean = fields
        .filter((f) => f.key.trim())
        .map((f) => ({
          ...f,
          key: f.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"),
          enumValues: f.type === "enum" ? f.enumValues?.filter(Boolean) : undefined,
        }));
      const res = await createAgentAction({
        name,
        systemPrompt,
        fields: clean,
        activate,
        workspaceId,
        orgId,
      });
      setError(res.error ?? null);
      if (!res.error) {
        setName("");
        setBaseKey("");
        setDescription("");
      }
    });

  const compiled = compileToJsonSchema({
    fields: fields.filter((f) => f.key.trim()) as never,
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Agent list */}
      <div className="space-y-4">
        <Card elevated>
          <h4 className="text-xs font-mono text-black uppercase tracking-wider font-bold mb-4">
            Deployed Agents
          </h4>
          <div className="space-y-3">
            {agents.length === 0 ? (
              <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-6 text-center">
                No agents yet
              </p>
            ) : (
              agents.map((agent) => (
                <div
                  key={`${agent.id}-${agent.version}`}
                  className="p-4 rounded-none border-2 border-neutral-200 bg-white space-y-2"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <span className="font-display font-black text-black text-sm block uppercase tracking-tight">
                        {agent.name}
                      </span>
                      <span className="text-[10px] font-mono text-neutral-500 font-bold uppercase">
                        v{agent.version} · {agent.field_schema?.fields?.length ?? 0} fields
                      </span>
                    </div>
                    <StatusChip tone={agent.is_active ? "solid" : "outline"}>
                      {agent.is_active ? "Active" : "Draft"}
                    </StatusChip>
                  </div>
                  {!agent.is_active ? (
                    <button
                      onClick={() =>
                        startTransition(() =>
                          activateAgentAction({ agentId: agent.id, version: agent.version, orgId }).then(() => undefined),
                        )
                      }
                      className="text-[10px] font-mono text-black underline hover:text-neutral-600 font-bold uppercase tracking-wider"
                    >
                      Set as Active
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Builder */}
      <div className="lg:col-span-2 space-y-6">
        <Card elevated className="space-y-4">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
              Describe With AI
            </h4>
          </div>
          <p className="text-xs text-neutral-400 font-sans font-medium">
            Say what the agent should do — it fills in the name, system prompt and fields below for
            you to review and adjust. Pick a &quot;Start from&quot; agent first to describe a
            <em> change</em> to it instead of a fresh one.
          </p>
          <textarea
            className={`${inputClass} h-20 leading-relaxed`}
            placeholder="e.g. An agent that scores how urgent the lead is and flags any budget objections raised"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <BrutalButton
            variant="secondary"
            disabled={pending || !description.trim()}
            onClick={generate}
          >
            <Wand2 className="h-3.5 w-3.5" />
            {pending ? "GENERATING…" : "GENERATE"}
          </BrutalButton>
          {generateError ? (
            <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
              {generateError}
            </p>
          ) : null}
        </Card>

        <Card elevated className="space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
              New Agent
            </h4>
          </div>

          {agents.length > 0 ? (
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-black uppercase tracking-wider font-bold flex items-center gap-1.5">
                <Copy className="h-3 w-3" /> Start From
              </label>
              <select className={selectClass} value={baseKey} onChange={(e) => applyBase(e.target.value)}>
                <option value="">Blank</option>
                {agents.map((agent) => (
                  <option key={`${agent.id}-${agent.version}`} value={`${agent.id}-${agent.version}`}>
                    {agent.name} (v{agent.version})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Name
            </label>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lead Qualifier" />
          </div>

          {/* Only worth a control when there is a choice to make; with one
              workspace the value is already pinned to the right tenant. */}
          {workspaces.length > 1 ? (
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
                Workspace
              </label>
              <select
                className={selectClass}
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              System Prompt
            </label>
            <textarea
              className={`${inputClass} h-24 leading-relaxed`}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>

          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <label className="text-xs font-mono text-black uppercase tracking-wider font-bold">
                Extraction Fields
              </label>
              <BrutalButton variant="secondary" onClick={() => setFields((p) => [...p, { ...EMPTY_FIELD }])}>
                <Plus className="h-3.5 w-3.5" /> Add Field
              </BrutalButton>
            </div>

            {fields.map((field, i) => (
              <div key={i} className="border-2 border-black bg-neutral-50 p-3.5 grid grid-cols-1 md:grid-cols-2 gap-3">
                <input
                  className={inputClass}
                  placeholder="key (snake_case)"
                  value={field.key}
                  onChange={(e) => updateField(i, { key: e.target.value })}
                />
                <select
                  className={inputClass}
                  value={field.type}
                  onChange={(e) => updateField(i, { type: e.target.value as AgentFieldInput["type"] })}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  className={`${inputClass} md:col-span-2`}
                  placeholder="description for the LLM"
                  value={field.description}
                  onChange={(e) => updateField(i, { description: e.target.value })}
                />
                {field.type === "enum" ? (
                  <input
                    className={`${inputClass} md:col-span-2 font-mono`}
                    placeholder="enum values, comma separated"
                    value={field.enumValues?.join(", ") ?? ""}
                    onChange={(e) =>
                      updateField(i, { enumValues: e.target.value.split(",").map((v) => v.trim()) })
                    }
                  />
                ) : null}
                <div className="flex items-center justify-between md:col-span-2">
                  <label className="flex items-center gap-2 text-xs font-mono font-bold uppercase cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 border-2 border-black rounded-none"
                      checked={field.required}
                      onChange={(e) => updateField(i, { required: e.target.checked })}
                    />
                    Required
                  </label>
                  <button
                    onClick={() => setFields((p) => p.filter((_, idx) => idx !== i))}
                    className="p-1.5 text-black hover:text-white hover:bg-black rounded-none border border-transparent hover:border-black"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-2">
            <label className="flex items-center gap-2 text-xs font-mono font-bold uppercase cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 border-2 border-black rounded-none"
                checked={activate}
                onChange={(e) => setActivate(e.target.checked)}
              />
              Activate immediately
            </label>
            <BrutalButton shadow disabled={pending || !name.trim()} onClick={submit}>
              {pending ? "CREATING..." : "CREATE AGENT V1"}
            </BrutalButton>
          </div>

          {error ? (
            <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
              {error}
            </p>
          ) : null}
        </Card>

        <Card elevated>
          <MonoLabel className="mb-2">Compiled Gemini responseSchema (live)</MonoLabel>
          <div className="bg-black rounded-none p-4 text-[10px] font-mono text-neutral-300 overflow-x-auto max-h-72 overflow-y-auto border-2 border-black">
            <pre>{JSON.stringify(compiled, null, 2)}</pre>
          </div>
        </Card>
      </div>
    </div>
  );
}
