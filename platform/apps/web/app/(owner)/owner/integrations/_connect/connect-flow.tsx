"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check } from "lucide-react";
import { NEVER_SENDS, connectErrorMessage, integrationById, safeConsolePath } from "@aura/shared";
import { Button, Card, ErrorBanner, buttonClasses } from "@aura/ui";
import { previousEntryTag } from "@/lib/nav-history";
import { AFTER_CONNECT } from "../app-copy";
import { appHref } from "../app-links";
import { AppLogo } from "../app-logo";
import { ADAPTERS } from "./registry";
import {
  CONNECT_PLANS,
  type ConnectStep,
  type ConnectableApp,
  originKey,
  stepAfter,
  stepBefore,
  stepFrom,
  stepTitle,
} from "./steps";
import type { ConnectData, StepProps } from "./types";

/**
 * The one connect flow (doc 28 §11): review → the method → a choice → a check
 * → done, with each app walking only the steps its plan names.
 *
 * ── THE STEP LIVES IN THE URL, AND STEPS REPLACE ────────────────────────────
 *
 * `?step=` survives a refresh and gives an OAuth return somewhere to land,
 * which local state could not. Moving between steps REPLACES the entry (R3):
 * a flow is one place, and the header's Back leaves it - for the page it was
 * opened from - rather than rewinding through every step on the way out. The
 * flow's own "← Previous step" is how a person goes back inside it.
 *
 * ── WHERE DONE GOES ─────────────────────────────────────────────────────────
 *
 * A door (Lead sources, Messaging setup) opens this with `?from=`. The path is
 * checked, kept in sessionStorage - per tab, so it survives the trip to Google
 * and back - and stripped from the URL. Done then returns there: through
 * history when the entry right behind is that page (its filters and scroll
 * come back with it), otherwise by replacing this entry with it, so Back from
 * the origin does not reopen a finished flow. No origin → the app's own page.
 */
export function ConnectFlow({ appId, data }: { appId: ConnectableApp; data: ConnectData }) {
  const spec = integrationById(appId)!;
  const plan = CONNECT_PLANS[appId];
  const adapter = ADAPTERS[appId];
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const errorCode = params.get("error");
  // A callback that failed lands back on the method step, whatever it named.
  const step: ConnectStep = errorCode && plan.steps.includes("auth") ? "auth" : stepFrom(plan, params.get("step"));
  const [error, setError] = useState<string | null>(() => connectErrorMessage(errorCode));

  // One-shot parameters: remember `from`, surface `error`, then take both
  // out of the URL so a refresh or a copied link does not replay them.
  useEffect(() => {
    const from = params.get("from");
    const code = params.get("error");
    if (from === null && code === null) return;
    const search = new URLSearchParams(params.toString());
    if (from !== null) {
      const safe = safeConsolePath(from, "", ["/owner"]);
      if (safe) {
        try {
          window.sessionStorage.setItem(originKey(data.orgId, appId), safe);
        } catch {
          // No storage: Done falls back to the app's page.
        }
      }
      search.delete("from");
    }
    if (code !== null) {
      setError(connectErrorMessage(code));
      search.delete("error");
      search.set("step", step);
    }
    const qs = search.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [params, pathname, router, data.orgId, appId, step]);

  const goTo = useCallback(
    (target: ConnectStep, extra: Record<string, string | null> = {}) => {
      const search = new URLSearchParams(params.toString());
      search.set("step", target);
      search.delete("error");
      for (const [key, value] of Object.entries(extra)) {
        if (value === null) search.delete(key);
        else search.set(key, value);
      }
      setError(null);
      router.replace(`${pathname}?${search.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const finish = () => {
    let origin: string | null = null;
    try {
      origin = window.sessionStorage.getItem(originKey(data.orgId, appId));
      window.sessionStorage.removeItem(originKey(data.orgId, appId));
    } catch {
      origin = null;
    }
    const target = origin ? safeConsolePath(origin, "", ["/owner"]) : "";
    if (target && previousEntryTag()?.href === target) {
      // Back restores the origin from the router's cache - scroll, filters
      // and all, which is the point - but as it was BEFORE the flow, without
      // the thing just connected. Ask for fresh data once it is on screen.
      window.addEventListener("popstate", () => setTimeout(() => router.refresh(), 0), { once: true });
      router.back();
      return;
    }
    router.replace(target || appHref(appId));
  };

  const props: StepProps = {
    spec,
    data,
    params: {
      pending: params.get("pending"),
      connected: params.get("connected"),
      via: params.get("via"),
    },
    next: (extra) => goTo(stepAfter(plan, step), extra),
    goTo,
    fail: setError,
  };

  const index = plan.steps.indexOf(step);
  const previous = step === "done" ? null : stepBefore(plan, step);
  const Body =
    step === "auth" ? adapter.Auth : step === "choose" ? adapter.Choose : step === "check" ? adapter.Check : null;

  return (
    <div className="max-w-3xl space-y-4">
      <nav aria-label="Connection steps">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          {plan.steps.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              {i > 0 ? <span aria-hidden="true" className="h-px w-4 bg-border-strong" /> : null}
              <span
                aria-current={s === step ? "step" : undefined}
                className={`inline-flex items-center gap-1.5 ${s === step ? "font-medium text-text" : ""}`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${
                    i < index
                      ? "border-transparent bg-text text-bg"
                      : s === step
                        ? "border-text text-text"
                        : "border-border-strong"
                  }`}
                >
                  {i < index ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                {stepTitle(plan, s)}
              </span>
            </li>
          ))}
        </ol>
        <p className="sr-only">
          Step {index + 1} of {plan.steps.length}: {stepTitle(plan, step)}
        </p>
      </nav>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {Body && adapter.unframed?.includes(step) ? (
        <Body {...props} />
      ) : (
        <Card>
          {step === "review" ? (
            <ReviewStep {...props} />
          ) : step === "done" ? (
            <DoneStep spec={spec} onDone={finish} />
          ) : Body ? (
            <Body {...props} />
          ) : (
            <ReviewStep {...props} />
          )}
        </Card>
      )}

      {previous ? (
        <button
          type="button"
          onClick={() => goTo(previous, { pending: null, connected: null })}
          className="text-sm text-text-muted underline-offset-4 hover:text-text hover:underline"
        >
          ← Previous step
        </button>
      ) : null}
    </div>
  );
}

/** Step one for every app: what it can touch, and what you need to hand (§11.1). */
function ReviewStep({ spec, next }: StepProps) {
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <AppLogo spec={spec} size="lg" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text">{spec.label} will be able to</h2>
          <p className="mt-0.5 text-sm text-text-muted">
            by {spec.vendor}
            {spec.scope === "person" ? " · connected to you, not the whole team" : ""}
          </p>
        </div>
      </div>

      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs font-medium tracking-wide text-text-muted uppercase">Read</dt>
          {spec.access.reads.map((r) => (
            <dd key={r} className="mt-1 text-text">
              {r}
            </dd>
          ))}
        </div>
        <div>
          <dt className="text-xs font-medium tracking-wide text-text-muted uppercase">Write</dt>
          {spec.access.writes.map((w) => (
            <dd key={w} className="mt-1 text-text">
              {w}
            </dd>
          ))}
        </div>
        <div>
          <dt className="text-xs font-medium tracking-wide text-text-muted uppercase">Never</dt>
          <dd className="mt-1 text-text">{NEVER_SENDS}</dd>
        </div>
      </dl>

      <div>
        <p className="text-xs font-medium tracking-wide text-text-muted uppercase">What you&apos;ll need</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-text marker:text-text-subtle">
          {spec.needs.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>

      {spec.notice ? <p className="text-sm font-medium text-text">{spec.notice}</p> : null}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button type="button" onClick={() => next()}>
          Continue
        </Button>
        <Link href={appHref(spec.id)} className="text-sm text-text-muted underline-offset-4 hover:text-text hover:underline">
          Not now
        </Link>
      </div>
    </div>
  );
}

function DoneStep({ spec, onDone }: { spec: StepProps["spec"]; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-hover text-text"
        >
          <Check className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text">{spec.label} is connected</h2>
          {AFTER_CONNECT[spec.id] ? (
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-text-muted">{AFTER_CONNECT[spec.id]}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={onDone}>
          Done
        </Button>
        <Link href={appHref(spec.id)} className={buttonClasses({ variant: "secondary" })}>
          Open {spec.label}
        </Link>
      </div>
    </div>
  );
}
