"use client";

import { useState, useTransition } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { BrutalButton, Card, EmptyState, MonoLabel, useAlert, useConfirm, useToast } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { inputClass } from "@/lib/form";
import { addOperatorAction, removeOperatorAction } from "./actions";

export interface OperatorRow {
  email: string;
  added_by: string;
  note: string | null;
  created_at: string;
}

/**
 * The superadmin list.
 *
 * `canManage` hides the controls for a non-root operator, but it is not what
 * stops them: the actions re-check on the server, because a hidden button is a
 * rendering decision and a Server Action is a public endpoint. This is the
 * courtesy, not the boundary.
 */
export function OperatorsManager({
  operators,
  canManage,
}: {
  operators: OperatorRow[];
  canManage: boolean;
}) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();
  const confirm = useConfirm();

  const add = () =>
    startTransition(async () => {
      const res = await addOperatorAction({ email, note });
      if (res.error) {
        await alert({ title: "Couldn't add that superadmin", body: res.error, tone: "danger" });
        return;
      }
      setEmail("");
      setNote("");
      toast(`${email.trim().toLowerCase()} is now a superadmin`);
    });

  const remove = (target: string) =>
    startTransition(async () => {
      const ok = await confirm({
        title: `Remove ${target}?`,
        body: "They lose access to the operator console immediately, on their next request. Their Supabase login itself is untouched.",
        confirmLabel: "Remove superadmin",
        tone: "danger",
      });
      if (!ok) return;
      const res = await removeOperatorAction(target);
      if (res.error) {
        await alert({ title: "Couldn't remove that superadmin", body: res.error, tone: "danger" });
        return;
      }
      toast(`${target} is no longer a superadmin`);
    });

  return (
    <>
      {canManage ? (
        <Card className="space-y-3">
          <MonoLabel>Appoint a superadmin</MonoLabel>
          <p className="text-xs text-text-muted">
            They must already be able to sign in - this grants console access to an existing
            account, it does not create one.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              className={inputClass}
              style={{ minWidth: "18rem" }}
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className={inputClass}
              style={{ minWidth: "14rem" }}
              placeholder="What for? (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <BrutalButton onClick={add} disabled={pending || !email.trim()}>
              <UserPlus className="h-4 w-4" />
              {pending ? "ADDING…" : "ADD"}
            </BrutalButton>
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
          <span className="text-sm font-medium text-text">Appointed superadmins</span>
          <span className="text-xs text-text-muted tabular-nums">{operators.length}</span>
        </div>

        {operators.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="Nobody appointed yet"
              description={
                canManage
                  ? "Add an address above and they can reach this console on their next sign-in."
                  : "Only the root operator can appoint one."
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {operators.map((op) => (
              <li key={op.email} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-text">{op.email}</span>
                  <span className="text-xs text-text-muted">
                    added by {op.added_by} · <LocalTime iso={op.created_at} mode="date" />
                    {op.note ? ` · ${op.note}` : ""}
                  </span>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => remove(op.email)}
                    disabled={pending}
                    aria-label={`Remove ${op.email}`}
                    className="shrink-0 rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-danger-text disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
