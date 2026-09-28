import Link from "next/link";
import { todayIn } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import {
  OWN_REQUEST_FILTERS,
  REQUEST_FILTERS,
  requestQuery,
  type AttendanceRequest,
  type OwnRequestFilter,
  type PeopleResponse,
  type RequestFilter,
} from "@/lib/attendance";
import { ownerTry } from "@/lib/owner-context";
import { RecordLeave } from "./record-leave";
import { RequestsList } from "./requests-list";

/**
 * Requests (doc 33 §6.3, §7.1). An owner or manager lands on "Waiting for
 * me"; a telecaller sees their own requests, which nobody on their side
 * decides, so they get plain Pending / Decided / All chips instead.
 */
export async function RequestsTab({
  role,
  zone,
  filterParam,
}: {
  role: string;
  zone: string;
  filterParam: string | undefined;
}) {
  const manages = role === "owner" || role === "manager";
  const chips: readonly { key: RequestFilter | OwnRequestFilter; label: string }[] = manages
    ? REQUEST_FILTERS
    : OWN_REQUEST_FILTERS;
  const filter = chips.find((c) => c.key === filterParam)?.key ?? chips[0]!.key;

  const [result, people] = await Promise.all([
    ownerTry<{ requests: AttendanceRequest[] }>(`/v1/owner/attendance/requests?${requestQuery(filter)}`),
    manages ? ownerTry<PeopleResponse>("/v1/owner/attendance/people") : Promise.resolve(null),
  ]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1.5" aria-label="Filter requests">
          {chips.map((c) => {
            const active = c.key === filter;
            return (
              <Link
                key={c.key}
                href={`/owner/attendance?tab=requests&filter=${c.key}`}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "rounded-full border border-border-strong bg-surface-hover px-3 py-1 text-sm font-medium text-text"
                    : "rounded-full border border-border px-3 py-1 text-sm text-text-muted hover:text-text"
                }
              >
                {c.label}
              </Link>
            );
          })}
        </nav>
        {manages && people?.ok ? (
          <RecordLeave
            people={people.data.people.map((p) => ({ id: p.telecallerId, name: p.name }))}
            zone={zone}
            today={todayIn(zone)}
          />
        ) : null}
      </div>

      {result.ok ? (
        <RequestsList initial={result.data.requests} zone={zone} />
      ) : (
        <LoadFailure what="requests" failure={result} />
      )}
    </>
  );
}
