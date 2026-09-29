import { IntroSkeleton, TablePanelSkeleton } from "@/components/skeletons";

/**
 * Mirrors instances/[id]/audit/page.tsx: the one-paragraph note about the ledger
 * being append-only and capped, then the panel holding the action / actor /
 * target / when table.
 *
 * Ten rows rather than the API's cap of 200 - the real table scrolls inside a
 * capped frame, so a fallback the full height of the cap would be a screen of
 * grey nothing.
 */
export default function InstanceAuditLoading() {
  return (
    <>
      <IntroSkeleton lines={2} />
      <TablePanelSkeleton columns={4} rows={10} />
    </>
  );
}
