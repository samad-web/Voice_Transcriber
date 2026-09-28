import { todayIn } from "@aura/shared";
import { DateRangeBar, DateRangeNotice, DateRangeSummary } from "@/components/date-range-bar";
import { LoadFailure } from "@/components/load-failure";
import type { ReviewSegment } from "@/lib/attendance";
import { parseDateWindow, rangePresets, resolveDateWindow } from "@/lib/date-range";
import { ownerTry } from "@/lib/owner-context";
import { ReviewList } from "./review-list";

const PATH = "/owner/attendance";
const DEFAULT_DAYS = 7;

/** Review (doc 33 §7.1), owner and manager only - the page does not offer the tab to anybody else. */
export async function ReviewTab({
  zone,
  searchParams,
}: {
  zone: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { window, invalid } = parseDateWindow(searchParams, { defaultDays: DEFAULT_DAYS });
  const today = todayIn(zone);
  const requested = resolveDateWindow(window, today);
  const result = await ownerTry<{ segments: ReviewSegment[] }>(
    `/v1/owner/attendance/review?${new URLSearchParams(requested)}`,
  );
  const keep = { tab: "review" };

  return (
    <>
      <DateRangeBar
        path={PATH}
        presets={rangePresets(PATH, window, { defaultDays: DEFAULT_DAYS, keep })}
        from={requested.from}
        to={requested.to}
        keep={keep}
        today={today}
      />
      {invalid ? <DateRangeNotice fallbackDays={DEFAULT_DAYS} /> : null}
      <DateRangeSummary from={requested.from} to={requested.to} zone={zone} />

      {result.ok ? (
        <ReviewList initial={result.data.segments} zone={zone} />
      ) : (
        <LoadFailure what="the review queue" failure={result} />
      )}
    </>
  );
}
