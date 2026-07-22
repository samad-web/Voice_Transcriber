import type { ReactNode } from "react";

/** White card with the Aura hard border; `shadow` adds the offset hard shadow. */
export function Card({
  children,
  shadow = false,
  className = "",
}: {
  children: ReactNode;
  shadow?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`bg-white p-5 rounded-none border-2 border-black ${
        shadow ? "shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]" : "shadow-xs"
      } ${className}`}
    >
      {children}
    </div>
  );
}
