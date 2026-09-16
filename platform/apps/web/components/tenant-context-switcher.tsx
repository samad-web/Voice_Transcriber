"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { useToast } from "@aura/ui";
import type { TenantAccent } from "@/lib/tenant-accent";

/** One tenant as the header shows it. Built on the server; every field is serialisable. */
export interface TenantChip {
  orgId: string;
  name: string;
  initials: string;
  logoUrl: string | null;
  /** The persona this person holds IN that tenant - it differs per membership. */
  roleLabel: string;
  accent: TenantAccent;
}

/**
 * Which tenant you are in, always on screen, and the way to change it.
 *
 * "Unmistakable" is carried by three channels at once, never colour alone:
 * the tenant's own logo or monogram, its name in full, and its accent (a
 * swatch here and the hairline across the top of the header - see
 * lib/tenant-accent.ts for why that accent can never be a state colour).
 *
 * With one membership it is a static badge: a dropdown with nothing to choose
 * is furniture. With several it opens a list, and choosing one posts
 * `switchAction` - the server validates the org against the session's own
 * memberships, sets the preference and lands on Home.
 */
export function TenantContextSwitcher({
  current,
  others,
  switchAction,
}: {
  current: TenantChip;
  others: TenantChip[];
  switchAction: (orgId: string) => Promise<{ error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [pendingOrg, setPendingOrg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const root = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const canSwitch = others.length > 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (orgId: string) => {
    setPendingOrg(orgId);
    startTransition(async () => {
      // On success the action redirects, so this only resolves on refusal.
      const result = await switchAction(orgId);
      if (result?.error) {
        toast(result.error);
        setPendingOrg(null);
      }
    });
  };

  const badge = (
    <>
      <span
        aria-hidden="true"
        className="h-7 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: current.accent.swatch }}
      />
      <TenantMark tenant={current} size="md" />
      <span className="min-w-0 text-left">
        <span className="block max-w-[11rem] truncate text-sm leading-tight font-semibold text-text sm:max-w-[14rem]">
          {current.name}
        </span>
        <span className="block truncate text-[11px] leading-tight text-text-muted">{current.roleLabel}</span>
      </span>
    </>
  );

  if (!canSwitch) {
    return (
      <div className="flex min-w-0 items-center gap-2" aria-label={`Workspace: ${current.name}`} role="group">
        {badge}
      </div>
    );
  }

  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Workspace: ${current.name}. Switch workspace`}
        className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 pl-1 transition-colors duration-150 ease-out hover:bg-surface-hover"
      >
        {badge}
        {pending ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-muted" aria-hidden="true" />
        ) : (
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        )}
      </button>

      {open ? (
        <div className="absolute left-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-surface shadow-lg">
          <p className="border-b border-border px-3 py-2 text-xs font-medium text-text">Switch workspace</p>
          <ul role="listbox" aria-label="Your workspaces" className="max-h-80 overflow-y-auto py-1">
            {[current, ...others].map((tenant) => {
              const isCurrent = tenant.orgId === current.orgId;
              return (
                <li key={tenant.orgId} role="option" aria-selected={isCurrent}>
                  <button
                    type="button"
                    disabled={isCurrent || pending}
                    onClick={() => choose(tenant.orgId)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: tenant.accent.swatch }}
                    />
                    <TenantMark tenant={tenant} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text">{tenant.name}</span>
                      <span className="block truncate text-[11px] text-text-muted">{tenant.roleLabel}</span>
                    </span>
                    {isCurrent ? (
                      <Check className="h-4 w-4 shrink-0 text-text" aria-label="Current workspace" />
                    ) : pendingOrg === tenant.orgId ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-muted" aria-hidden="true" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function TenantMark({ tenant, size }: { tenant: TenantChip; size: "sm" | "md" }) {
  const box = size === "md" ? "h-8 w-8 text-xs" : "h-6 w-6 text-[10px]";
  if (tenant.logoUrl) {
    // A bare <img>: the host is tenant-supplied and arbitrary - see @aura/ui's Logo.
    return (
      <img
        src={tenant.logoUrl}
        alt=""
        aria-hidden="true"
        className={`${box} shrink-0 rounded-md border border-border bg-surface object-contain`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${box} inline-flex shrink-0 items-center justify-center rounded-md font-semibold`}
      style={{ backgroundColor: tenant.accent.tileBg, color: tenant.accent.tileFg }}
    >
      {tenant.initials}
    </span>
  );
}
