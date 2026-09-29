"use client";

import { useState, useTransition } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Checkbox,
  FormField,
  Input,
  MonoLabel,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { createApiKeyAction, revokeApiKeyAction, type CreatedKey } from "./keys-actions";

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

/** Head strip shared with team-manager.tsx and the instance page's TablePanel. */
const PANEL_HEAD =
  "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-bg-subtle px-5 py-3";

/**
 * One client's API keys.
 *
 * ── THEMED, AS OF THE client-config CONSOLIDATION ──────────────────────────
 *
 * Restyled onto semantic tokens for the same reason as team-manager.tsx beside
 * it: both were pre-v2 holdouts in stock Tailwind, and once they became two tabs
 * of one page, a dark-mode reader would have got one themed tab and two that
 * painted black rules on a black page. It is off `console-palette.test.ts`'s
 * backlog.
 *
 * Two colour choices worth stating, because this file is the console's only
 * legitimate use of either:
 *
 *  - the secret box uses the `terminal` ramp (`bg-terminal`,
 *    `text-terminal-log`, `border-terminal-border`), which is a FIXED dark
 *    surface in both themes by design - it was `bg-black text-green-400`, and
 *    the point of a terminal-looking box is that it looks the same everywhere.
 *    The tokens carry the contrast figures; the raw hexes did not.
 *  - "Copy now" stays the kit's `StatusChip tone="danger"` and the card keeps a
 *    danger border, now as the `border-danger` token rather than
 *    `border-red-600`. Red means MISSED in this console (packages/ui/src/
 *    state.tsx) and this is not a missed call - but re-deciding what hue "you
 *    will never see this secret again" deserves is a colour-rule question, not a
 *    dark-mode one, so the intent is preserved verbatim and left for that pass.
 */
export function ApiKeysManager({ keys, orgId }: { keys: ApiKey[]; orgId?: string }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();

  const create = () =>
    startTransition(async () => {
      const res = await createApiKeyAction(name.trim(), scopes, orgId);
      if (res.error) {
        setCreated(null);
        await alert({ title: "Couldn't create the API key", body: res.error, tone: "danger" });
        return;
      }
      setCreated(res);
      setName("");
      setScopes([]);
    });

  const toggleScope = (value: string) =>
    setScopes((current) =>
      current.includes(value) ? current.filter((s) => s !== value) : [...current, value],
    );

  // Confirm BEFORE opening the transition, not inside it: an async transition
  // stays pending for as long as the dialog is up, which would grey the whole
  // panel out while the person is still deciding.
  const revoke = async (id: string) => {
    const ok = await confirm({
      title: "Revoke this API key?",
      body: "Any integration using it stops working immediately. The key's name, scopes and usage history are kept.",
      confirmLabel: "Revoke key",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await revokeApiKeyAction(id, orgId);
      if (res.error) {
        await alert({ title: "Couldn't revoke the API key", body: res.error, tone: "danger" });
      }
    });
  };

  // Sync handler, not `async`: React drops whatever an event handler returns, so
  // an async onClick hands it a promise nobody owns and a rejected clipboard
  // write (insecure origin, permission denied - both real for a console reached
  // over plain http or inside an iframe) surfaces only as an unhandled
  // rejection. Resolve it here instead, and say so loudly when it fails - this
  // secret is shown exactly once, so a copy the person believes happened and
  // did not is how the key is lost.
  const copyKey = () => {
    const key = created?.key;
    if (!key) return;
    void navigator.clipboard
      .writeText(key)
      .then(() => toast("API key copied"))
      .catch(() =>
        alert({
          title: "Couldn't copy the API key",
          body: "Select it from the box above and copy it by hand - it is shown only once.",
          tone: "danger",
        }),
      );
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* Key list */}
      <div className="lg:col-span-2">
        <Card className="overflow-hidden p-0">
          <div className={PANEL_HEAD}>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-text-muted">
                <KeyRound className="h-4 w-4" />
              </span>
              <span className="text-sm font-medium text-text">API keys</span>
            </div>
            <span className="text-xs text-text-muted tabular-nums">
              {keys.length} {keys.length === 1 ? "key" : "keys"}
            </span>
          </div>
          {keys.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-text-muted">
              No API keys yet - create one to authenticate this client&apos;s integrations
            </p>
          ) : (
            <div tabIndex={0} role="region" aria-label="API keys" className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                <caption className="sr-only">API keys for this client</caption>
                <TableHead>
                  <tr>
                    <TableHeaderCell>Key</TableHeaderCell>
                    <TableHeaderCell>Last used</TableHeaderCell>
                    <TableHeaderCell>Created</TableHeaderCell>
                    <TableHeaderCell className="text-right">Action</TableHeaderCell>
                  </tr>
                </TableHead>
                <TableBody>
                  {keys.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell>
                        <span className="block font-medium text-text">
                          {k.name}
                          {k.active === false ? (
                            <span className="ml-2 align-middle">
                              <StatusChip tone="danger">Revoked</StatusChip>
                            </span>
                          ) : null}
                        </span>
                        <span className="font-mono text-xs text-text-muted">{k.prefix}…</span>
                        {/* What it can actually do, on the row - so an audit is
                            reading this table, not cross-referencing the API. */}
                        <span className="mt-1 flex flex-wrap gap-1">
                          {(k.scopes ?? []).length === 0 ? (
                            <span className="font-mono text-xs font-medium text-danger">
                              no scopes - this key cannot do anything
                            </span>
                          ) : (
                            (k.scopes ?? []).map((s) => (
                              <span
                                key={s}
                                className="rounded-sm border border-border px-1 py-0.5 font-mono text-xs text-text-muted"
                              >
                                {s}
                              </span>
                            ))
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-text-muted">
                        {k.last_used_at ? <LocalTime iso={k.last_used_at} /> : "never"}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-text-muted">
                        <LocalTime iso={k.created_at} mode="date" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          disabled={pending}
                          onClick={() => void revoke(k.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Create key */}
      <div className="space-y-6">
        <Card className="space-y-4">
          <span className="block text-sm font-medium text-text">Create key</span>
          <p className="text-sm text-text-muted">
            The full secret is shown exactly once. Store it somewhere safe.
          </p>

          <FormField label="Key name" name="key-name">
            <Input
              placeholder="e.g. CRM Sync"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>

          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-text">What this key may do</span>
            <p className="text-xs leading-relaxed text-text-muted">
              A key can only do what you tick here. It can never send messages, delete records, or
              reach call recordings or transcripts.
            </p>
            <div className="space-y-1.5 pt-1">
              {SCOPE_CHOICES.map((choice) => (
                <div
                  key={choice.value}
                  className="rounded-md border border-border p-2.5 transition-colors duration-150 ease-out hover:border-border-strong"
                >
                  <Checkbox
                    label={choice.label}
                    description={choice.hint}
                    checked={scopes.includes(choice.value)}
                    onChange={() => toggleScope(choice.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          <Button
            type="button"
            className="w-full"
            onClick={create}
            loading={pending}
            disabled={!name.trim() || scopes.length === 0}
          >
            <Plus className="h-4 w-4" />
            Create key
          </Button>
        </Card>

        {created?.key ? (
          <Card className="space-y-4 border-danger">
            <div className="flex items-start justify-between gap-2">
              <div>
                <MonoLabel>Secret key - shown once</MonoLabel>
                <p className="mt-1 text-sm font-medium text-text">{created.name}</p>
              </div>
              <StatusChip tone="danger">Copy now</StatusChip>
            </div>

            <div className="space-y-1.5">
              <div className="rounded-md border border-terminal-border bg-terminal p-2.5 font-mono text-xs break-all text-terminal-log">
                {created.key}
              </div>
              <Button type="button" variant="secondary" className="w-full" onClick={copyKey}>
                <Copy className="h-4 w-4" />
                Copy key
              </Button>
            </div>

            <p className="border-t border-border pt-3 text-xs leading-relaxed text-text-muted">
              This secret will never be shown again. If you lose it, revoke the key and create a new
              one.
            </p>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
