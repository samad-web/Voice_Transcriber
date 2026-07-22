import type { ReactNode } from "react";

/** The tiny uppercase wide-tracking mono label used across the Aura design. */
export function MonoLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`text-[10px] font-mono text-neutral-400 uppercase tracking-[0.2em] font-bold ${className}`}
    >
      {children}
    </p>
  );
}
