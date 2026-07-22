"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock, User } from "lucide-react";
import { NAV_ITEMS } from "@/lib/nav";

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex flex-col w-64 bg-white border-r-2 border-black p-5 shrink-0 justify-between">
      <div className="space-y-8">
        <div className="flex items-center gap-3 px-1.5">
          <div className="w-10 h-10 bg-black text-white flex items-center justify-center font-bold font-display text-xl select-none">
            A
          </div>
          <div>
            <h1 className="text-sm font-display font-black text-black tracking-tight leading-none uppercase">
              Aura Platform
            </h1>
            <span className="text-[9px] font-mono font-bold text-neutral-400 block tracking-[0.2em] uppercase mt-1">
              Call Intelligence
            </span>
          </div>
        </div>

        <nav className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-none text-xs font-display font-bold uppercase tracking-wider transition-all ${
                  isActive
                    ? "bg-black text-white border-l-4 border-black"
                    : "text-neutral-500 hover:text-black hover:bg-neutral-50 border-l-4 border-transparent"
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="space-y-4 border-t-2 border-black pt-4 px-1">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-black text-white rounded-none">
            <User className="h-4 w-4" />
          </div>
          <div className="overflow-hidden">
            {/* TODO: real session principal once OIDC lands */}
            <span className="text-[11px] font-sans font-bold text-black block truncate">
              Not signed in
            </span>
            <span className="text-[9px] font-mono text-neutral-400 block uppercase font-bold tracking-wider">
              Session pending
            </span>
          </div>
        </div>

        <div className="text-[10px] text-neutral-500 font-mono flex items-center gap-1.5 pt-1 border-t border-neutral-100">
          <Lock className="h-3.5 w-3.5 text-black" />
          <span className="uppercase tracking-wider font-bold text-[9px]">Secure Session</span>
        </div>
      </div>
    </aside>
  );
}
