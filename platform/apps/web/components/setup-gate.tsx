"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  CreditCard,
  ImagePlus,
  Inbox,
  Megaphone,
  MessageCircle,
  Smartphone,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button, Dialog, StatusChip } from "@aura/ui";
import { setupBannerDetail, type SetupStepId, type SetupState } from "@aura/shared";
import { dismissSetupAction } from "@/app/(owner)/owner/setup-actions";

/**
 * The new-client setup checklist: a banner that stays, and a modal that asks
 * once (migration 0095).
 *
 * ── WHY THE MODAL IS SESSION-SCOPED AND THE BANNER IS NOT ─────────────────
 *
 * They are answering different questions. The modal asks "shall we walk you
 * through this now?", which is a question about this sitting - asking it again
 * on the next navigation would make the console unusable, so "Complete later"
 * silences it until the next login via `sessionStorage`.
 *
 * The banner states "your account is not finished yet", which stays true until
 * it is. Letting that be dismissed would mean a client could hide the reason
 * their console looks empty and then report the emptiness as a bug. The only
 * way to remove the banner is to finish the steps - or to say explicitly that
 * you are not going to, which is what "Don't show this again" does, and which
 * an owner has to choose rather than click past.
 *
 * ── WHY sessionStorage AND NOT A COOKIE OR A COLUMN ───────────────────────
 *
 * A column would need a write on a dismissal that means nothing beyond this
 * sitting, and a cookie would carry it to a shared machine's next user. The
 * requirement is exactly what `sessionStorage` already is: per tab, gone on
 * close. It can throw in a locked-down browser, so every access is guarded and
 * the failure mode is the modal opening again - annoying, never broken.
 */

const ICONS: Record<SetupStepId, LucideIcon> = {
  handset: Smartphone,
  team: Users,
  logo: ImagePlus,
  billing: CreditCard,
  whatsapp: MessageCircle,
  lead_sources: Inbox,
  meta_ads: Megaphone,
};

const SEEN_KEY = "aura.setup.deferred";

function deferredThisSession(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode, or a browser configured to refuse site data. Showing the
    // modal is the safe failure: the client can always close it.
    return false;
  }
}

function deferForSession(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* Nothing to do - see above. */
  }
}

export function SetupGate({
  setup,
  canDismiss,
}: {
  setup: SetupState;
  /** Owner only. A manager sees the checklist but cannot retire it - the API
   *  enforces the same split, this just avoids offering a button that 403s. */
  canDismiss: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Opened from an effect, not from initial state, because `sessionStorage` does
  // not exist while this renders on the server - reading it in a `useState`
  // initialiser is the classic hydration mismatch, and the symptom would be the
  // modal flashing open for every client on every page.
  useEffect(() => {
    if (!deferredThisSession()) setOpen(true);
  }, []);

  if (setup.complete) return null;

  const detail = setupBannerDetail(setup);

  const later = () => {
    deferForSession();
    setOpen(false);
  };

  const go = () => {
    // Straight to the first thing that is not done, rather than to a hub page
    // that would ask them to choose again. `nextHref` is computed by the same
    // pure function that ordered the list they are looking at, so the button
    // always lands on the step sitting at the top of the modal.
    deferForSession();
    setOpen(false);
    if (setup.nextHref) router.push(setup.nextHref);
  };

  const dismissForever = () => {
    startTransition(async () => {
      const result = await dismissSetupAction();
      if (!result.error) {
        setOpen(false);
        router.refresh();
      }
    });
  };

  return (
    <>
      {/* ── The banner ──────────────────────────────────────────────────── */}
      <div
        // `status`, not `alert`: nothing has gone wrong and nothing is urgent.
        // An assertive announcement here would interrupt a screen-reader user
        // on every single navigation until they finished onboarding.
        role="status"
        className="print-hide flex flex-wrap items-start gap-x-4 gap-y-2 rounded-xl border border-warning-text/30 bg-warning-subtle px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-warning-text">
            Finish setting up your account
            <span className="ml-2 font-normal">
              {setup.requiredDone} of {setup.requiredTotal} done
            </span>
          </p>
          {detail ? <p className="mt-0.5 text-sm text-warning-text">{detail}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 text-sm font-semibold text-warning-text underline underline-offset-2"
        >
          Finish set up
        </button>
      </div>

      {/* ── The modal ───────────────────────────────────────────────────── */}
      <Dialog
        open={open}
        onClose={later}
        title="Finish your account setup"
        description="A few things left before your console is doing everything it can."
        footer={
          <>
            <Button variant="secondary" onClick={later} disabled={pending}>
              Complete later
            </Button>
            <Button onClick={go} disabled={pending || !setup.nextHref}>
              Complete account setup
            </Button>
          </>
        }
      >
        {/*
          WHAT IS ALREADY RUNNING, first.

          The modal used to open on four unticked boxes, which answers "how
          much work is ahead of me" for somebody who has just been provisioned,
          paired a handset and watched it record. This answers "what have I
          got" first, and every line is measured - `readinessLines` returns an
          empty array for a tenant where genuinely nothing has happened yet, and
          the whole block disappears rather than rendering an empty heading.
        */}
        {setup.readiness && setup.readiness.length > 0 ? (
          <div className="mb-4 rounded-xl border border-border bg-surface-hover px-4 py-3">
            <p className="text-sm font-semibold text-text">Already running</p>
            <ul className="mt-2 space-y-1">
              {setup.readiness.map((line) => (
                <li key={line.id} className="flex items-start gap-2 text-sm text-text-muted">
                  {/* Grey, not green. Nothing here is a STATE in the console's
                      colour system - these are facts, and the functional
                      palette reserves hue for the four states in state.tsx. */}
                  <span
                    aria-hidden
                    className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted"
                  />
                  <span>{line.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <ul className="divide-y divide-border">
          {setup.steps.map((step) => {
            const Icon = ICONS[step.id];
            return (
              <li key={step.id} className="flex items-start gap-3 py-4">
                <span
                  aria-hidden
                  className={
                    step.done
                      ? "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success text-bg"
                      : "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-text"
                  }
                >
                  {step.done ? <Check className="h-4 w-4" /> : <Icon className="h-5 w-5" />}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        step.done
                          ? "text-base font-semibold text-text-muted line-through"
                          : "text-base font-semibold text-text"
                      }
                    >
                      {step.label}
                    </span>
                    {/* Only ever on things that are BOTH outstanding and
                        required - a "Required" chip beside a ticked row is
                        noise, and beside an optional one is a lie. */}
                    {step.required && !step.done ? (
                      <StatusChip tone="danger">Required</StatusChip>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-text-muted">{step.blurb}</p>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-4 text-xs text-text-muted">
          Nothing here blocks you - everything already set up works now.
          {canDismiss ? (
            <>
              {" "}
              <button
                type="button"
                onClick={dismissForever}
                disabled={pending}
                className="underline underline-offset-2"
              >
                Don&apos;t show this again
              </button>
              .
            </>
          ) : null}
        </p>
      </Dialog>
    </>
  );
}
