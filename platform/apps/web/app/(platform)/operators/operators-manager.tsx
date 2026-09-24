"use client";

import { type ReactNode, useState, useTransition } from "react";
import { Copy, KeyRound, RotateCcw, Trash2, UserPlus } from "lucide-react";
import {
  BrutalButton,
  Card,
  ConsolePanel,
  EmptyState,
  MonoLabel,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { inputClass } from "@/lib/form";
import {
  addOperatorAction,
  createOperatorLoginAction,
  removeOperatorAction,
  resetOperatorPasswordAction,
} from "./actions";

export interface OperatorRow {
  email: string;
  added_by: string;
  note: string | null;
  created_at: string;
}

/**
 * The superadmin list, and the two things a root operator needs to do with it:
 * decide who is one, and give them a way to sign in.
 *
 * `canManage` hides the controls for a non-root operator, but it is not what
 * stops them: the actions re-check on the server, because a hidden button is a
 * rendering decision and a Server Action is a public endpoint. This is the
 * courtesy, not the boundary.
 */
export function OperatorsManager({
  operators,
  canManage,
  rootEmail,
}: {
  operators: OperatorRow[];
  canManage: boolean;
  rootEmail: string | null;
}) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  // The one password this page has ever seen. Held in memory only - a reload
  // loses it, which is the same contract the enrollment key and the owner
  // account password already make.
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);
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

  // Confirm BEFORE opening the transition, not inside it: an async transition
  // stays pending for as long as the dialog is up, which greys the whole panel
  // out while the person is still deciding.
  const remove = async (target: string) => {
    const ok = await confirm({
      title: `Remove ${target}?`,
      body: "They lose access to the operator console immediately, on their next request. Their Supabase login itself is untouched - removing them here does not delete the account.",
      confirmLabel: "Remove superadmin",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await removeOperatorAction(target);
      if (res.error) {
        await alert({ title: "Couldn't remove that superadmin", body: res.error, tone: "danger" });
        return;
      }
      toast(`${target} is no longer a superadmin`);
    });
  };

  const createLogin = async (target: string) => {
    const ok = await confirm({
      title: `Create a login for ${target}?`,
      body: "A password is generated and shown once, here, on this screen. Send it over a channel they trust and have them change it after their first sign-in.",
      confirmLabel: "Create login",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await createOperatorLoginAction(target);
      if (res.error || !res.password) {
        await alert({
          title: "Couldn't create that login",
          body: res.error ?? "The API returned no password.",
          tone: "danger",
        });
        return;
      }
      setCredential({ email: res.email ?? target, password: res.password });
    });
  };

  const resetPassword = async (target: string) => {
    const isSelf = rootEmail !== null && target === rootEmail;
    const ok = await confirm({
      title: isSelf ? "Reset your own password?" : `Reset the password for ${target}?`,
      // The root's own reset is the one that can end badly, so it says so. There
      // is no forgotten-password flow anywhere in this console - a root who
      // resets and loses the string has locked itself out of its own platform,
      // and the only remedy left is the Supabase dashboard.
      body: isSelf
        ? "The new password is shown once and there is no forgotten-password flow in this console. Copy it before you close the box, or you will need the Supabase dashboard to get back in. Your current session stays signed in."
        : "Their old password stops working. The new one is shown once, here - send it over a channel they trust. Any session they already have open stays signed in.",
      confirmLabel: isSelf ? "Reset my password" : "Reset password",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await resetOperatorPasswordAction(target);
      if (res.error || !res.password) {
        await alert({
          title: "Couldn't reset that password",
          body: res.error ?? "The API returned no password.",
          tone: "danger",
        });
        return;
      }
      setCredential({ email: res.email ?? target, password: res.password });
    });
  };

  return (
    <>
      {canManage ? (
        <Card className="space-y-3">
          <MonoLabel>Appoint a superadmin</MonoLabel>
          <p className="text-xs text-text-muted">
            This grants console access to an address. If they have no Aura login yet, appoint them
            first and then use <span className="font-medium text-text">Create login</span> on their
            row below.
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

      {credential ? (
        <PasswordReveal
          email={credential.email}
          password={credential.password}
          onDismiss={() => setCredential(null)}
        />
      ) : null}

      {canManage && rootEmail ? (
        <Card className="space-y-3">
          <MonoLabel>Your own sign-in</MonoLabel>
          <p className="text-xs text-text-muted">
            The root operator is configured in the environment, so it is not in the list below and
            cannot be removed from here. This is the only place it can be given a new password.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-medium text-text">{rootEmail}</span>
            <RowButton
              onClick={() => void resetPassword(rootEmail)}
              disabled={pending}
              icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
              label="Reset my password"
            />
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
              <li
                key={op.email}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-text">{op.email}</span>
                  <span className="text-xs text-text-muted">
                    added by {op.added_by} · <LocalTime iso={op.created_at} mode="date" />
                    {op.note ? ` · ${op.note}` : ""}
                  </span>
                </div>
                {canManage ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <RowButton
                      onClick={() => void createLogin(op.email)}
                      disabled={pending}
                      icon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
                      label="Create login"
                    />
                    <RowButton
                      onClick={() => void resetPassword(op.email)}
                      disabled={pending}
                      icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
                      label="Reset password"
                    />
                    <button
                      type="button"
                      onClick={() => void remove(op.email)}
                      disabled={pending}
                      aria-label={`Remove ${op.email}`}
                      className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-danger-text disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** A plain button, not a kit one: a `className` handed to a kit component loses
 *  to its own base class, so the small row controls style themselves. */
function RowButton({
  onClick,
  disabled,
  icon,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The password, once.
 *
 * Same one-time contract as the enrollment key and the owner-account password
 * (`instances/[id]/owner-accounts.tsx`), and dismissed by hand rather than on a
 * timer: this is the only copy that will ever exist, so nothing takes it off
 * the screen except the person who asked for it.
 */
function PasswordReveal({
  email,
  password,
  onDismiss,
}: {
  email: string;
  password: string;
  onDismiss: () => void;
}) {
  const alert = useAlert();
  const toast = useToast();

  return (
    <Card className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonoLabel>Password for {email} - shown once</MonoLabel>
        <StatusChip tone="danger">Copy now</StatusChip>
      </div>
      <ConsolePanel lines={[password]} tone="log" />
      <div className="flex flex-wrap gap-2">
        <BrutalButton
          variant="secondary"
          // Sync, not `async` - React discards an event handler's return value,
          // so an async onClick turns a rejected clipboard write (insecure
          // origin, denied permission) into an unhandled rejection. This
          // password is never shown again, so a failed copy must SAY so.
          onClick={() => {
            void navigator.clipboard
              .writeText(password)
              .then(() => toast("Password copied"))
              .catch(() =>
                alert({
                  title: "Couldn't copy the password",
                  body: "Select it above and copy it by hand - it is not shown again.",
                  tone: "danger",
                }),
              );
          }}
        >
          <Copy className="h-4 w-4" />
          COPY PASSWORD
        </BrutalButton>
        <BrutalButton variant="secondary" onClick={onDismiss}>
          DONE
        </BrutalButton>
      </div>
      <p className="text-xs text-text-muted">
        Send it over a channel they trust, and have them change it after signing in. There is no
        forgotten-password flow in this console - a lost password is reset here, never recovered.
      </p>
    </Card>
  );
}
