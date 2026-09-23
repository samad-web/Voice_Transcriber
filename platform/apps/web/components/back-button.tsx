"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Tooltip, headerIconButtonClass } from "@aura/ui";
import { useBackTarget } from "@/components/nav-history-provider";

/**
 * The console's Back control (doc 28 §3): upper right-centre of the header,
 * beside the ☰ on a phone, first in the operator console's top row.
 *
 * ── A LINK, NOT A BUTTON ────────────────────────────────────────────────────
 *
 * It is a real anchor to the Up target. When the page behind is ours (tier 1)
 * a plain left click is intercepted and becomes `router.back()`, which is what
 * brings back the list's filters, page and scroll. Everything else stays a
 * link on purpose: a middle-click or Ctrl-click opens the parent in a new tab,
 * Enter behaves like a click, and it works before JavaScript arrives.
 *
 * There is no keyboard shortcut. Alt+← already means browser back, and tier 1
 * is exactly that whenever the target is ours.
 *
 * ── WHERE IT GOES AND WHAT IT SAYS ──────────────────────────────────────────
 *
 * <NavHistoryProvider> decides; this only draws. The visible word is "Back"
 * (from `lg`, icon-only below), and the destination is in the tooltip and the
 * accessible name - "Back to Contacts" - because "Back" alone does not say
 * where. Grey only: nothing in the header is call state.
 */
export function BackButton({
  variant = "header",
  className,
}: {
  /** `header`: the round header control. `bar`: the phone bar's square pair to ☰. */
  variant?: "header" | "bar";
  /** The phone bar passes its own icon-button classes so the pair matches. */
  className?: string;
}) {
  const target = useBackTarget();
  const router = useRouter();
  if (!target) return null;

  const label = `Back to ${target.label}`;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (target.kind !== "history") return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.back();
  };

  if (variant === "bar") {
    return (
      <Link href={target.href} prefetch={false} aria-label={label} onClick={onClick} className={className}>
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
      </Link>
    );
  }

  return (
    <Tooltip content={label} side="bottom">
      <Link
        href={target.href}
        // Every page renders this; prefetching every page's parent would be a
        // server round trip per navigation for a link that is usually
        // intercepted into history anyway.
        prefetch={false}
        aria-label={label}
        onClick={onClick}
        className={`${headerIconButtonClass()} lg:w-auto lg:gap-1.5 lg:px-3 lg:text-sm lg:font-medium ${className ?? ""}`}
      >
        <ArrowLeft className="h-[18px] w-[18px]" aria-hidden="true" />
        <span className="hidden lg:inline">Back</span>
      </Link>
    </Tooltip>
  );
}
