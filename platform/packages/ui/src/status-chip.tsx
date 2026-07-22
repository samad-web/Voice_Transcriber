import type { ReactNode } from "react";

const TONES = {
  solid: "bg-black text-white",
  muted: "bg-neutral-200 text-black",
  outline: "bg-white text-neutral-500",
  danger: "bg-red-500 text-white",
} as const;

export function StatusChip({
  children,
  tone = "solid",
  className = "",
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-none border border-black ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
