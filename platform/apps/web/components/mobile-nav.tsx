"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Lock, Menu, User, X } from "lucide-react";
import { Logo } from "@aura/ui";
import type { OwnerRole } from "@aura/shared";
import { NAV_ITEMS, navItemFor, ownerNavItemsFor, type NavArea } from "@/lib/nav";
import { SignOutButton } from "@/components/sign-out-button";

/**
 * Navigation below the `md` breakpoint, where <Sidebar> is hidden: a sticky top
 * bar plus a slide-in drawer. Without this the app had no way to change page on
 * a phone at all.
 */
export function MobileNav({
  email,
  /** See <Sidebar>: the nav array holds icon components and cannot be a prop. */
  area = "platform",
  /** Owner-console persona (design doc §9); ignored when area !== "owner". */
  ownerRole,
  /** See <Sidebar>: A6's shadow-read flag, resolved server-side and passed down. */
  crmPrimary = false,
  /** See <Sidebar>: whether this org has the CRM module, resolved server-side. */
  crmEnabled = true,
  /** Whether this org has the call-intelligence module - hides the call log. */
  callIntelEnabled = false,
  title = "Aura Platform",
  subtitle = "Call Intelligence",
}: {
  email?: string | null;
  area?: NavArea;
  ownerRole?: OwnerRole;
  crmPrimary?: boolean;
  crmEnabled?: boolean;
  callIntelEnabled?: boolean;
  title?: string;
  subtitle?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const items =
    area === "owner" ? ownerNavItemsFor(ownerRole ?? "owner", crmPrimary, crmEnabled, callIntelEnabled) : NAV_ITEMS;
  const current = navItemFor(pathname, items);

  // Focus management for the drawer-as-dialog: the trigger opens it, the close
  // button receives focus on open, Tab is trapped inside while it's open, and
  // focus returns to the trigger on close - otherwise a keyboard user tabbing
  // "through" the drawer lands on the (visually hidden, scrim-covered) page
  // behind it.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  // Tracks whether the *previous* render had the drawer open, so the
  // open-vs-close focus effect below can tell "just closed" apart from
  // "never opened" - without it, mount would try to focus a trigger that
  // was never blurred.
  const wasOpenRef = useRef(false);

  // Navigating (or resizing up into the sidebar breakpoint) must not leave the
  // drawer mounted over the page.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      closeButtonRef.current?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      // Manual focus trap: this kit has no focus-trap dependency (checked
      // package.json), and the drawer's contents are simple enough that a
      // keydown cycle beats pulling one in for it.
      const root = drawerRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Freeze the page behind the drawer so touch scrolling stays in the panel.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The trigger and the drawer's close button. Both are icon-only, so both must
  // carry an accessible name, and neither may lose its focus ring - with the
  // 2px black outline retired there is nothing else marking them as controls.
  const iconButton =
    "inline-flex shrink-0 items-center justify-center rounded-md border border-border-strong " +
    "bg-surface text-text transition-colors duration-150 ease-out active:bg-surface-hover";

  return (
    <>
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface px-4 py-3 md:hidden">
        <Logo size={28} priority />
        <div className="min-w-0 flex-1">
          <span className="block text-xs leading-tight text-text-muted">Aura</span>
          <span className="mt-0.5 block truncate text-sm font-semibold leading-tight text-text">
            {current?.title ?? "Platform"}
          </span>
        </div>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          className={`${iconButton} h-10 w-10`}
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      <AnimatePresence>
        {open ? (
          <>
            <motion.div
              // The scrim is the one place a literal black is still right: it is
              // a shadow over the page, not a surface, and it must darken in
              // both modes rather than flip with the theme.
              className="fixed inset-0 z-40 bg-black/40 md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.nav
              ref={drawerRef}
              aria-label="Main"
              role="dialog"
              aria-modal="true"
              className="fixed right-0 top-0 z-50 flex h-dvh w-[85%] max-w-xs flex-col overflow-y-auto border-l border-border bg-surface shadow-lg md:hidden"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
            >
              <div className="flex items-center justify-between border-b border-border p-4">
                <div className="min-w-0 pr-2">
                  <span className="block truncate text-sm font-semibold leading-tight text-text">
                    {title}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-text-muted">{subtitle}</span>
                </div>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                  className={`${iconButton} h-9 w-9`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <div className="flex-1 space-y-0.5 p-3">
                {items.map((item) => {
                  const Icon = item.icon;
                  // Reuse the same longest-prefix match `current` already
                  // holds (used above for the header title) instead of
                  // testing each item's own prefix independently - otherwise
                  // Dashboard ("/owner") matches every owner route's prefix
                  // test too, and renders active alongside the real page.
                  const isActive = item === current;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      style={isActive ? { backgroundImage: "var(--brand-gradient)" } : undefined}
                      className={`flex w-full items-center gap-3 rounded-full px-3 py-3 text-sm font-medium transition-colors duration-150 ease-out ${
                        // Same brand-register active state as <Sidebar>; the two
                        // rails must agree on what "you are here" looks like.
                        isActive ? "text-white" : "text-text-muted active:bg-surface-hover"
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>

              <div className="space-y-3 border-t border-border p-4">
                <div className="flex items-center gap-2.5">
                  <div
                    aria-hidden="true"
                    className="shrink-0 rounded-full bg-surface-hover p-2 text-text-muted"
                  >
                    <User className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="block truncate text-xs font-medium text-text">
                      {/* `||` not `??` - an account with no email arrives as "". */}
                      {email || "Not signed in"}
                    </span>
                    <span className="block text-xs text-text-muted">
                      {email ? "Signed in" : "Session pending"}
                    </span>
                  </div>
                </div>

                {/* Always rendered - see the note in sidebar.tsx. On a phone this
                    is the ONLY sign-out that exists, since the desktop sidebar
                    is hidden below md. */}
                <SignOutButton />

                <div className="flex items-center gap-1.5 border-t border-border pt-3 text-xs text-text-muted">
                  <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>Secure session</span>
                </div>
              </div>
            </motion.nav>
          </>
        ) : null}
      </AnimatePresence>
    </>
  );
}
