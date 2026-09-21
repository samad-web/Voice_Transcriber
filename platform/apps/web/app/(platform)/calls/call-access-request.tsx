"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Button, Card, Input, MonoLabel } from "@aura/ui";
import {
  redeemCallAccessOtpAction,
  requestCallAccessAction,
  sendCallAccessOtpAction,
  getCallAccessStateAction,
  type CallAccessState,
} from "./call-access-actions";

/**
 * What an operator sees instead of a customer's call log when that customer
 * has not agreed to let us read it (migration 0122).
 *
 * The tone is deliberate. This is not an error and it is not a paywall - the
 * customer has made a choice about their own recordings, and the screen says
 * so plainly rather than implying something is broken or that support is being
 * obstructed. The only actions offered are the two honest ones: ask, or carry
 * a code they read out.
 *
 * There is no "override", no "emergency access" and no escalation path here,
 * because there is none on the API either. If one is ever added it belongs in
 * front of the customer, not behind a button on the vendor's screen.
 */
export function CallAccessRequest({
  orgId,
  tenantName,
  message,
}: {
  orgId: string;
  tenantName: string;
  message: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [state, setState] = useState<CallAccessState | null>(null);
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("4");
  const [code, setCode] = useState("");

  const openRequest = useMemo(
    () => state?.requests.find((r) => r.status === "pending") ?? null,
    [state],
  );

  const refresh = () =>
    startTransition(async () => {
      const result = await getCallAccessStateAction(orgId);
      if (result.error) setError(result.error);
      else setState(result.state ?? null);
    });

  const submit = () =>
    startTransition(async () => {
      setError(null);
      setNote(null);
      const start = new Date();
      const end = new Date(start.getTime() + Math.max(1, Number(hours) || 4) * 3_600_000);
      const result = await requestCallAccessAction(
        orgId,
        reason,
        start.toISOString(),
        end.toISOString(),
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setNote(`Request sent to ${tenantName}. They are notified in their console.`);
      const next = await getCallAccessStateAction(orgId);
      setState(next.state ?? null);
    });

  const sendCode = () =>
    startTransition(async () => {
      setError(null);
      setNote(null);
      if (!openRequest) return;
      const result = await sendCallAccessOtpAction(orgId, openRequest.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setNote(
        `A code was sent to the administrator's number ending ${result.toLast3 ?? "----"}. Ask them to read it to you.`,
      );
    });

  const redeem = () =>
    startTransition(async () => {
      setError(null);
      setNote(null);
      if (!openRequest) return;
      const result = await redeemCallAccessOtpAction(orgId, openRequest.id, code);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Lock className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <div>
            <MonoLabel>Approval required</MonoLabel>
            <p className="mt-2 max-w-prose text-sm text-text-muted">
              {message ||
                `${tenantName} has asked that their call logs, recordings and transcripts stay private until they approve access.`}
            </p>
            {openRequest ? (
              <p className="mt-2 text-sm text-text-muted">
                A request is already with them
                {openRequest.attempts > 1 ? ` (${openRequest.attempts} attempts)` : ""}. They can
                approve it from their own console, or read you a one-time code.
              </p>
            ) : null}
          </div>
        </div>

        {error ? <p className="text-sm text-[var(--aura-danger,#c0392b)]">{error}</p> : null}
        {note ? <p className="text-sm text-text-muted">{note}</p> : null}

        {!state ? (
          <div>
            <Button onClick={refresh} disabled={pending} variant="secondary">
              Check request status
            </Button>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border-strong pt-4">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-text-muted">
              Why do you need access? The customer reads this and decides on it.
            </span>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Investigating a failed transcription reported on 18 Sep"
            />
          </label>
          <label className="flex w-40 flex-col gap-1 text-xs">
            <span className="text-text-muted">For how many hours?</span>
            <Input
              type="number"
              min={1}
              max={720}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </label>
          <div>
            <Button onClick={submit} disabled={pending || !reason.trim()}>
              {openRequest ? "Update request" : "Request access"}
            </Button>
          </div>
        </div>

        {openRequest ? (
          <div className="flex flex-col gap-3 border-t border-border-strong pt-4">
            <MonoLabel>Or use a one-time code</MonoLabel>
            <p className="max-w-prose text-xs text-text-muted">
              Sends a WhatsApp message to the customer&apos;s administrator with the reason and the
              exact window above. They read the code back to you only if they agree. Switched off
              unless this deployment enables it.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Button variant="secondary" onClick={sendCode} disabled={pending}>
                Send code
              </Button>
              <label className="flex w-40 flex-col gap-1 text-xs">
                <span className="text-text-muted">Code they read out</span>
                <Input
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                />
              </label>
              <Button onClick={redeem} disabled={pending || code.trim().length !== 6}>
                Unlock
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
