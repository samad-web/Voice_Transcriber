import { SectionHeadingSkeleton, TablePanelSkeleton } from "@/components/skeletons";

/**
 * Mirrors instances/[id]/devices/page.tsx: the "Enrolled handsets" panel
 * (device / telecaller / capability / fingerprint / last seen / state / actions),
 * then the Enrollment section - a heading, the key generator, and the "Issued
 * keys" table.
 *
 * A fragment, not a shell: the back link, the tenant header, the vitals strip and
 * the tab strip are drawn by `../layout.tsx` and are already on screen while this
 * shows.
 */
export default function InstanceDevicesLoading() {
  return (
    <>
      <TablePanelSkeleton columns={7} rows={5} />
      <SectionHeadingSkeleton />
      <TablePanelSkeleton columns={4} rows={3} />
    </>
  );
}
