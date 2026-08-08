import type { Metadata } from "next";
import { Container } from "@/components/ui/layout";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

/** Doc 10 §14 requires a designed 404. */
export default function NotFound() {
  return (
    <Container className="py-24">
      <div className="max-w-xl">
        <p className="text-base font-medium text-accent-text">404</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text">
          That page isn&rsquo;t here
        </h1>
        <p className="mt-4 text-lg text-text-muted">
          The link may be out of date. Everything on the site is reachable from the
          homepage.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href="/">Back to the homepage</ButtonLink>
          <ButtonLink href="/compatibility" variant="secondary">
            Check phone compatibility
          </ButtonLink>
        </div>
      </div>
    </Container>
  );
}
