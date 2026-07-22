import type { ReactNode } from "react";

/** Black terminal-style log panel (green for pipeline logs, red for destructive ops). */
export function ConsolePanel({
  lines,
  tone = "log",
  header,
  className = "",
}: {
  lines: string[];
  tone?: "log" | "danger" | "neutral";
  header?: ReactNode;
  className?: string;
}) {
  const toneClass =
    tone === "danger" ? "text-red-400" : tone === "neutral" ? "text-neutral-300" : "text-green-400";
  return (
    <div
      className={`bg-black rounded-none p-4 font-mono text-[11px] overflow-y-auto space-y-1.5 border-2 border-black ${toneClass} ${className}`}
    >
      {header ? (
        <span className="text-[9px] text-neutral-400 block mb-2 uppercase tracking-wider font-bold">
          {header}
        </span>
      ) : null}
      {lines.map((line, i) => (
        <div key={i} className="leading-relaxed">
          {line}
        </div>
      ))}
    </div>
  );
}
