"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

const VARIANTS = {
  primary:
    "bg-black text-white hover:bg-neutral-800 border-2 border-black",
  secondary:
    "bg-white text-black hover:bg-neutral-50 border-2 border-black",
  destructive:
    "bg-red-500 text-white hover:bg-red-600 border-2 border-black",
} as const;

export function BrutalButton({
  children,
  variant = "primary",
  shadow = false,
  className = "",
  ...rest
}: {
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
  shadow?: boolean;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`flex items-center justify-center gap-2 font-display font-bold uppercase tracking-wider text-xs px-4 py-2.5 rounded-none transition-all cursor-pointer disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed ${
        VARIANTS[variant]
      } ${shadow ? "shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
