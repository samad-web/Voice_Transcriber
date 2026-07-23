"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Lock, Menu, User, X } from "lucide-react";
import { NAV_ITEMS, navItemFor } from "@/lib/nav";
import { SignOutButton } from "@/components/sign-out-button";

/**
 * Navigation below the `md` breakpoint, where <Sidebar> is hidden: a sticky top
 * bar plus a slide-in drawer. Without this the app had no way to change page on
 * a phone at all.
 */
export function MobileNav({ email }: { email?: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = navItemFor(pathname);

  // Navigating (or resizing up into the sidebar breakpoint) must not leave the
  // drawer mounted over the page.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Freeze the page behind the drawer so touch scrolling stays in the panel.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <header className="md:hidden sticky top-0 z-30 flex items-center gap-3 bg-white border-b-2 border-black px-4 py-3">
        <div className="w-9 h-9 bg-black text-white flex items-center justify-center font-bold font-display text-lg select-none shrink-0">
          A
        </div>
        <div className="min-w-0 flex-1">
          <span className="text-[9px] font-mono font-bold text-neutral-400 block tracking-[0.2em] uppercase leading-none">
            Aura
          </span>
          <span className="text-xs font-display font-black text-black block uppercase tracking-tight truncate mt-0.5">
            {current?.title ?? "Platform"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          className="p-2 border-2 border-black bg-white text-black rounded-none shrink-0 active:bg-black active:text-white"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      <AnimatePresence>
        {open ? (
          <>
            <motion.div
              className="md:hidden fixed inset-0 bg-black/40 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.nav
              aria-label="Main"
              className="md:hidden fixed right-0 top-0 h-dvh w-[85%] max-w-xs bg-white border-l-4 border-black z-50 flex flex-col overflow-y-auto"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
            >
              <div className="flex items-center justify-between border-b-2 border-black p-4">
                <div>
                  <span className="text-sm font-display font-black uppercase tracking-tight leading-none block">
                    Aura Platform
                  </span>
                  <span className="text-[9px] font-mono font-bold text-neutral-400 block tracking-[0.2em] uppercase mt-1">
                    Call Intelligence
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                  className="p-1.5 border-2 border-black text-black rounded-none active:bg-black active:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 p-3 space-y-1">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-none text-xs font-display font-bold uppercase tracking-wider transition-all ${
                        isActive
                          ? "bg-black text-white border-l-4 border-black"
                          : "text-neutral-500 active:bg-neutral-100 border-l-4 border-transparent"
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>

              <div className="border-t-2 border-black p-4 space-y-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 bg-black text-white rounded-none shrink-0">
                    <User className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="text-[11px] font-sans font-bold text-black block truncate">
                      {email ?? "Not signed in"}
                    </span>
                    <span className="text-[9px] font-mono text-neutral-400 block uppercase font-bold tracking-wider">
                      {email ? "Signed in" : "Session pending"}
                    </span>
                  </div>
                </div>

                {email ? <SignOutButton /> : null}

                <div className="text-[10px] text-neutral-500 font-mono flex items-center gap-1.5 pt-1 border-t border-neutral-100">
                  <Lock className="h-3.5 w-3.5 text-black shrink-0" />
                  <span className="uppercase tracking-wider font-bold text-[9px]">
                    Secure Session
                  </span>
                </div>
              </div>
            </motion.nav>
          </>
        ) : null}
      </AnimatePresence>
    </>
  );
}
