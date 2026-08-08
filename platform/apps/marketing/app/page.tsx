import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { Landing } from "@/components/landing";
import { pageMetadata } from "@/lib/metadata";
import { BRAND, LEGAL_ENTITY, SITE_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Aura: every call, accounted for",
  description:
    "Aura records your telecallers' calls, transcribes them in Tamil and English, " +
    "and turns every conversation into a lead with the details already filled in.",
  path: "/",
});

/**
 * Homepage — five sections, one way in.
 *
 * Reduced from thirteen on 2026-08-08. The sections that came off (pricing,
 * integrations, FAQ, language proof, compatibility teaser, trust block, the
 * custom-CRM fork, the demo placeholder) are still built and still routed on
 * their own pages; they are off the homepage, not removed. The single
 * conversion target is /start.
 */
export default function HomePage() {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: BRAND,
          applicationCategory: "BusinessApplication",
          operatingSystem: "Android",
          url: SITE_URL,
          publisher: { "@type": "Organization", name: LEGAL_ENTITY },
        }}
      />
      <Landing />
    </>
  );
}
