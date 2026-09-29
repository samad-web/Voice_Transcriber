import { CardGridSkeleton, FormFieldsSkeleton, SectionHeadingSkeleton } from "@/components/skeletons";

/**
 * Mirrors instances/[id]/settings/page.tsx and its four sections: Modules (four
 * toggle cards, 2x2), Capture & retention (the ASR panel beside the policy and
 * app-lock forms), Owner sign-ins, and the danger zone's two cards.
 */
export default function InstanceSettingsLoading() {
  return (
    <>
      <SectionHeadingSkeleton />
      <CardGridSkeleton count={4} columns={2} />
      <SectionHeadingSkeleton />
      <FormFieldsSkeleton />
      <SectionHeadingSkeleton />
      <CardGridSkeleton count={2} columns={2} />
    </>
  );
}
