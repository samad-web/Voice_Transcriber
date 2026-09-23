"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { formatDateTime, instantToWallTime, timeZoneShortLabel, wallTimeToInstant } from "@aura/shared";
import { Button, Card, Input, MonoLabel, StatusChip } from "@aura/ui";
import { useOrgTimeZone } from "@/components/org-time";
import {
  approveCallAccessAction,
  denyCallAccessAction,
  revokeCallAccessAction,
  updateCallAccessSettingsAction,
} from "./actions";

export interface CallAccessRequest {
  id: string;
  requested_by_email: string;
  reason: string;
  status: "pending" | "approved" | "denied" | "revoked";
  requested_start: string;
  requested_end: string;
  granted_start: string | null;
  granted_end: string | null;
  decided_at: string | null;
  decided_via: "console" | "otp" | null;
  decided_by_name: string | null;
  revoked_at: string | null;
  attempts: number;
  last_attempt_at: string;
  otp_sent_at: string | null;
  otp_sent_to_last3: string | null;
  created_at: string;
  /** Computed by the API so this screen and the guard cannot disagree. */
  live: boolean;
}

export interface CallAccessData {
  gateEnabled: boolean;
  designatedAdmin: { userId: string; name: string | null; email: string | null } | null;
  requests: CallAccessRequest[];
}

/**
 * The customer's view of who has asked to hear their calls.
 *
 * The screen is deliberately blunt. Everywhere else in this console the
 * product explains features; here it states a fact about the vendor, and the
 * wording avoids the softening ("manage access", "permissions") that makes a
 * privacy control read like a settings page nobody opens.
 *
 * The default window offered on approval is four hours from now, NOT the
 * window that was asked for. The requested window is shown plainly beside it,
 * but it is the operator's proposal and pre-filling the form with it would
 * make "approve" mean "accept whatever they asked for" - which is how a
 * consent screen becomes a formality.
 */
export function CallAccessClient({
  data,
  canDecide,
}: {
  data: CallAccessData;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const zone = useOrgTimeZone();

  const open = data.requests.filter((r) => r.status === "pending");
  const liveGrants = data.requests.filter((r) => r.live);
  const past = data.requests.filter((r) => r.status !== "pending" && !r.live);

  const run = (fn: () => Promise<{ error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
      else router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Card>
          <p className="text-sm text-[var(--aura-danger,#c0392b)]">{error}</p>
        </Card>
      ) : null}

      <GateCard data={data} canDecide={canDecide} pending={pending} run={run} />

      <section className="flex flex-col gap-3">
        <MonoLabel>Waiting for you ({open.length})</MonoLabel>
        {open.length === 0 ? (
          <Card>
            <p className="text-sm opacity-70">
              Nobody is waiting on a decision. If someone tries to open your call logs, the request
              appears here and you are notified.
            </p>
          </Card>
        ) : (
          open.map((request) => (
            <PendingCard
              key={request.id}
              request={request}
              canDecide={canDecide}
              pending={pending}
              run={run}
            />
          ))
        )}
      </section>

      {liveGrants.length > 0 ? (
        <section className="flex flex-col gap-3">
          <MonoLabel>Active right now ({liveGrants.length})</MonoLabel>
          {liveGrants.map((request) => (
            <Card key={request.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{request.requested_by_email}</p>
                  <p className="text-sm opacity-70">
                    Can see your call logs until {formatWhen(request.granted_end, zone)}.
                  </p>
                  <p className="mt-1 text-xs opacity-60">
                    Approved {request.decided_via === "otp" ? "by code" : "in the console"}
                    {request.decided_by_name ? ` by ${request.decided_by_name}` : ""}.
                  </p>
                </div>
                {canDecide ? (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => run(() => revokeCallAccessAction(request.id))}
                  >
                    Stop access now
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <MonoLabel>History</MonoLabel>
        {past.length === 0 ? (
          <Card>
            <p className="text-sm opacity-70">Nothing yet.</p>
          </Card>
        ) : (
          past.map((request) => (
            <Card key={request.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm">{request.requested_by_email}</p>
                  <p className="text-xs opacity-60">{request.reason}</p>
                </div>
                <StatusChip tone={request.status === "approved" ? "muted" : "danger"}>
                  {labelFor(request, zone)}
                </StatusChip>
              </div>
            </Card>
          ))
        )}
      </section>
    </div>
  );
}

function GateCard({
  data,
  canDecide,
  pending,
  run,
}: {
  data: CallAccessData;
  canDecide: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ error?: string }>) => void;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {data.gateEnabled ? (
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          ) : (
            <ShieldOff className="mt-0.5 h-5 w-5 shrink-0 opacity-60" aria-hidden />
          )}
          <div>
            <p className="text-sm font-semibold">
              {data.gateEnabled
                ? "Your call recordings are protected"
                : "Your call recordings are not protected"}
            </p>
            <p className="mt-1 max-w-prose text-sm opacity-70">
              {data.gateEnabled
                ? "Support staff must ask you before they can open your call logs, recordings or transcripts, and every approval you give ends at a time you choose."
                : "Support staff can currently open your call logs, recordings and transcripts without asking. Turn this on to require your approval each time."}
            </p>
            {data.designatedAdmin ? (
              <p className="mt-2 text-xs opacity-60">
                Requests go to {data.designatedAdmin.name ?? data.designatedAdmin.email}.
              </p>
            ) : (
              <p className="mt-2 text-xs opacity-60">Requests go to everyone with the Owner role.</p>
            )}
          </div>
        </div>

        {canDecide ? (
          <Button
            variant={data.gateEnabled ? "secondary" : "primary"}
            disabled={pending}
            onClick={() =>
              run(() =>
                updateCallAccessSettingsAction({
                  gateEnabled: !data.gateEnabled,
                  // Carried through unchanged. This button changes one thing.
                  designatedAdminUserId: data.designatedAdmin?.userId ?? null,
                }),
              )
            }
          >
            {data.gateEnabled ? "Turn off" : "Turn on"}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function PendingCard({
  request,
  canDecide,
  pending,
  run,
}: {
  request: CallAccessRequest;
  canDecide: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ error?: string }>) => void;
}) {
  // The inputs are wall times on the WORKSPACE's clock (Build docs/30 R5), not
  // the laptop's: an owner abroad granting access "until 18:00" means the
  // 18:00 their team reads everywhere else in the console.
  const zone = useOrgTimeZone();
  const zoneHintId = useId();
  // Four hours from now, rounded to the minute - a deliberate default that is
  // not what was asked for. See the component header.
  const defaults = useMemo(() => {
    const now = Date.now();
    const end = now + 4 * 60 * 60 * 1000;
    return { start: instantToWallTime(now, zone), end: instantToWallTime(end, zone) };
  }, [zone]);
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm font-semibold">{request.requested_by_email}</p>
          <p className="mt-1 text-sm opacity-80">{request.reason}</p>
          <p className="mt-2 text-xs opacity-60">
            They asked for {formatWhen(request.requested_start, zone)} to{" "}
            {formatWhen(request.requested_end, zone)}.
            {request.attempts > 1
              ? ` They have tried to open your call logs ${request.attempts} times.`
              : ""}
            {request.otp_sent_to_last3
              ? ` A code was sent to the number ending ${request.otp_sent_to_last3}.`
              : ""}
          </p>
        </div>

        {canDecide ? (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="opacity-70">Access starts</span>
                <Input
                  type="datetime-local"
                  value={start}
                  aria-describedby={zoneHintId}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="opacity-70">Access ends</span>
                <Input
                  type="datetime-local"
                  value={end}
                  aria-describedby={zoneHintId}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
              <p id={zoneHintId} className="pb-2 text-xs opacity-60">
                Times in {timeZoneShortLabel(zone)}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending}
                onClick={() =>
                  run(() =>
                    // An empty or unreadable input goes through as "", so the
                    // action's validateCallAccessWindow answers it in a sentence.
                    approveCallAccessAction(
                      request.id,
                      wallTimeToInstant(start, zone) ?? "",
                      wallTimeToInstant(end, zone) ?? "",
                    ),
                  )
                }
              >
                Allow until {formatWallTime(end, zone)}
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => run(() => denyCallAccessAction(request.id))}
              >
                Decline
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs opacity-60">Only an Owner can decide this.</p>
        )}
      </div>
    </Card>
  );
}

function labelFor(request: CallAccessRequest, zone: string): string {
  if (request.status === "denied") return "Declined";
  if (request.status === "revoked") return "Stopped";
  if (request.status === "approved") return `Ended ${formatWhen(request.granted_end, zone)}`;
  return request.status;
}

/** A `datetime-local` value, read on the workspace's clock; left as typed if it is not one. */
function formatWallTime(value: string, zone: string): string {
  const at = wallTimeToInstant(value, zone);
  return at ? formatDateTime(at, zone) : value;
}

function formatWhen(value: string | null, zone: string): string {
  if (!value) return "—";
  const text = formatDateTime(value, zone);
  return text === "-" ? value : text;
}
