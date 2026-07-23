import type { ReactNode } from "react";
import { Card } from "./card";
import { MonoLabel } from "./mono-label";

export function StatCard({
  label,
  value,
  icon,
  footer,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="flex flex-col justify-between">
      <div className="flex justify-between items-start gap-2">
        {/* min-w-0 + break-words: long values (region codes, 7-digit counts)
            wrap inside a narrow single-column card instead of overflowing it. */}
        <div className="min-w-0">
          <MonoLabel>{label}</MonoLabel>
          <h3 className="text-3xl sm:text-4xl font-display font-black text-black mt-2 break-words">
            {value}
          </h3>
        </div>
        {icon ? <div className="p-2 bg-black text-white rounded-none shrink-0">{icon}</div> : null}
      </div>
      {footer ? (
        <div className="mt-4 pt-3 border-t border-neutral-200 flex items-center text-[10px] font-mono text-neutral-500 gap-1.5 uppercase tracking-wider font-bold">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}
