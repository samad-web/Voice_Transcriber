import type { ReactNode } from "react";
import { Skeleton } from "@aura/ui";
import { LoadingRegion } from "@/components/skeletons";

/** A step fetching what it shows. Announced - Skeleton alone is aria-hidden. */
export function StepLoading({ label }: { label: string }) {
  return (
    <LoadingRegion label={label} className="space-y-3">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-3 w-full max-w-prose" />
      <div className="space-y-2 pt-2">
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-10 w-full rounded-md" />
      </div>
    </LoadingRegion>
  );
}

/** The title and one paragraph every step opens with, so the steps read as one flow. */
export function StepHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-text">{title}</h2>
      {children ? <p className="mt-1 max-w-prose text-sm leading-relaxed text-text-muted">{children}</p> : null}
    </div>
  );
}

/** The row of buttons at the foot of a step. */
export function StepActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex flex-wrap items-center gap-2">{children}</div>;
}
