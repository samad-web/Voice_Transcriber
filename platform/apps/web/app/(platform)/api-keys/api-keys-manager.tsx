"use client";

import { useState, useTransition } from "react";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { createApiKeyAction, revokeApiKeyAction, type CreatedKey } from "./actions";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  created_at: string;
}

const inputClass =
  "w-full p-2.5 border-2 border-black bg-neutral-50 rounded-none text-sm font-sans text-black focus:outline-none";

export function ApiKeysManager({ keys }: { keys: ApiKey[] }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const create = () =>
    startTransition(async () => {
      setError(null);
      setCopied(false);
      const res = await createApiKeyAction(name.trim());
      if (res.error) {
        setError(res.error);
        setCreated(null);
      } else {
        setCreated(res);
        setName("");
      }
    });

  const revoke = (id: string) =>
    startTransition(async () => {
      if (!window.confirm("Revoke this API key? Any integration using it stops working immediately."))
        return;
      await revokeApiKeyAction(id);
    });

  const copyKey = async () => {
    if (!created?.key) return;
    await navigator.clipboard.writeText(created.key);
    setCopied(true);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Key list */}
      <div className="lg:col-span-2">
        <Card shadow className="overflow-hidden p-0">
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
                        <span className="font-display font-bold text-black block">{k.name}</span>
                        <span className="text-[10px] font-mono text-neutral-400">
                          {k.prefix}…
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
        <Card shadow className="space-y-4">
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

          <BrutalButton className="w-full" shadow disabled={pending || !name.trim()} onClick={create}>
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
          <Card shadow className="space-y-4 border-red-600">
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
