"use client";

import { useState, useTransition } from "react";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { inputClass } from "@/lib/form";
import { createApiKeyAction, revokeApiKeyAction, type CreatedKey } from "./actions";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes?: string[] | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at?: string | null;
  active?: boolean;
}

/**
 * The scopes an operator may grant, grouped so the consequence of each is
 * readable at the moment of granting rather than in the API docs.
 *
 * Mirrors `API_SCOPES` in @aura/shared, which the database also constrains
 * (0076). Deliberately not imported from there: this list carries human-facing
 * copy the shared module has no business holding, and an integration test pins
 * the two against the live CHECK constraint so they cannot silently diverge.
 */
const SCOPE_CHOICES: Array<{ value: string; label: string; hint: string }> = [
  { value: "leads:write", label: "Create leads", hint: "Push leads in. Includes reading them." },
  { value: "leads:read", label: "Read leads", hint: "List and fetch leads." },
  { value: "contacts:read", label: "Read contacts", hint: "Names and part-masked numbers only." },
  { value: "deals:read", label: "Read deals", hint: "Pipeline, stage and value." },
  { value: "projects:read", label: "Read projects", hint: "Your project catalogue." },
  {
    value: "mcp",
    label: "Allow AI agents (MCP)",
    hint: "Lets this key connect an AI assistant. Grant with the data scopes above.",
  },
];

export function ApiKeysManager({ keys, orgId }: { keys: ApiKey[]; orgId?: string }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const create = () =>
    startTransition(async () => {
      setError(null);
      setCopied(false);
      const res = await createApiKeyAction(name.trim(), scopes, orgId);
      if (res.error) {
        setError(res.error);
        setCreated(null);
      } else {
        setCreated(res);
        setName("");
        setScopes([]);
      }
    });

  const toggleScope = (value: string) =>
    setScopes((current) =>
      current.includes(value) ? current.filter((s) => s !== value) : [...current, value],
    );

  const revoke = (id: string) =>
    startTransition(async () => {
      if (!window.confirm("Revoke this API key? Any integration using it stops working immediately."))
        return;
      await revokeApiKeyAction(id, orgId);
    });

  // Sync handler, not `async`: React drops whatever an event handler returns, so
  // an async onClick hands it a promise nobody owns and a rejected clipboard
  // write (insecure origin, permission denied — both real for a console reached
  // over plain http or inside an iframe) surfaces only as an unhandled
  // rejection. Resolve it here instead, and on failure clear `copied` rather
  // than leave the button claiming COPIED from an earlier successful click —
  // this secret is shown exactly once, so a false "copied" loses it.
  const copyKey = () => {
    const key = created?.key;
    if (!key) return;
    void navigator.clipboard
      .writeText(key)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Key list */}
      <div className="lg:col-span-2">
        <Card elevated className="overflow-hidden p-0">
          <div className="p-5 border-b-2 border-black flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
              API Keys
            </h4>
          </div>
          {keys.length === 0 ? (
            <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-10 text-center">
              No API keys yet — create one to authenticate integrations
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left border-collapse">
                <thead>
                  <tr className="bg-neutral-100 border-b-2 border-black font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                    <th className="py-3.5 px-5">Key</th>
                    <th className="py-3.5 px-4">Last Used</th>
                    <th className="py-3.5 px-4">Created</th>
                    <th className="py-3.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-neutral-100 text-sm">
                  {keys.map((k) => (
                    <tr key={k.id} className="hover:bg-neutral-50">
                      <td className="py-4 px-5">
                        <span className="font-display font-bold text-black block">
                          {k.name}
                          {k.active === false ? (
                            <span className="ml-2 align-middle">
                              <StatusChip tone="danger">Revoked</StatusChip>
                            </span>
                          ) : null}
                        </span>
                        <span className="text-[10px] font-mono text-neutral-400">
                          {k.prefix}…
                        </span>
                        {/* What it can actually do, on the row — so an audit is
                            reading this table, not cross-referencing the API. */}
                        <span className="mt-1 flex flex-wrap gap-1">
                          {(k.scopes ?? []).length === 0 ? (
                            <span className="text-[10px] font-mono text-red-700 font-bold">
                              no scopes — this key cannot do anything
                            </span>
                          ) : (
                            (k.scopes ?? []).map((s) => (
                              <span
                                key={s}
                                className="text-[10px] font-mono border border-neutral-300 px-1 py-0.5 text-neutral-600"
                              >
                                {s}
                              </span>
                            ))
                          )}
                        </span>
                      </td>
                      <td className="py-4 px-4 font-mono text-xs">
                        {k.last_used_at ? <LocalTime iso={k.last_used_at} /> : "never"}
                      </td>
                      <td className="py-4 px-4 font-mono text-xs">
                        <LocalTime iso={k.created_at} mode="date" />
                      </td>
                      <td className="py-4 px-4 text-right">
                        <BrutalButton
                          variant="destructive"
                          className="px-2.5 py-1.5"
                          disabled={pending}
                          onClick={() => revoke(k.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Revoke
                        </BrutalButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Create key */}
      <div className="space-y-6">
        <Card elevated className="space-y-4">
          <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
            Create Key
          </h4>
          <p className="text-xs text-neutral-400 font-sans font-medium">
            The full secret is shown exactly once. Store it somewhere safe.
          </p>

          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              Key Name
            </label>
            <input
              className={inputClass}
              placeholder="e.g. CRM Sync"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              What this key may do
            </label>
            <p className="text-[11px] text-neutral-500 font-sans font-medium">
              A key can only do what you tick here. It can never send messages, delete records, or
              reach call recordings or transcripts.
            </p>
            <div className="space-y-1.5 pt-1">
              {SCOPE_CHOICES.map((choice) => (
                <label
                  key={choice.value}
                  className="flex gap-2.5 items-start border-2 border-neutral-200 hover:border-black p-2.5 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-black shrink-0"
                    checked={scopes.includes(choice.value)}
                    onChange={() => toggleScope(choice.value)}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-display font-bold text-black">
                      {choice.label}
                    </span>
                    <span className="block text-[10px] text-neutral-500 font-sans">
                      {choice.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <BrutalButton
            className="w-full"
            shadow
            disabled={pending || !name.trim() || scopes.length === 0}
            onClick={create}
          >
            <Plus className="h-4 w-4" />
            {pending ? "GENERATING…" : "CREATE KEY"}
          </BrutalButton>

          {error ? (
            <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
              {error}
            </p>
          ) : null}
        </Card>

        {created?.key ? (
          <Card elevated className="space-y-4 border-red-600">
            <div className="flex justify-between items-start gap-2">
              <div>
                <MonoLabel>Secret Key — shown once</MonoLabel>
                <h4 className="text-lg font-display font-black text-black uppercase tracking-tight mt-1">
                  {created.name}
                </h4>
              </div>
              <StatusChip tone="danger">Copy now</StatusChip>
            </div>

            <div className="space-y-1.5">
              <div className="bg-black text-green-400 border-2 border-black p-2.5 font-mono text-xs break-all">
                {created.key}
              </div>
              <BrutalButton variant="secondary" className="w-full" onClick={copyKey}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "COPIED" : "COPY KEY"}
              </BrutalButton>
            </div>

            <p className="text-[11px] text-neutral-600 font-sans font-medium leading-relaxed border-t-2 border-neutral-200 pt-3">
              This secret will never be shown again. If you lose it, revoke the key and create a new
              one.
            </p>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
