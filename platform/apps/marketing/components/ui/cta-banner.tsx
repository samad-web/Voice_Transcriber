import { ButtonLink } from "./button";
import { WhatsAppCta } from "./whatsapp-cta";
import { FUNNEL_LIVE } from "@/lib/site";

/**
 * A conversion band: one question, one primary WhatsApp CTA, one secondary.
 *
 * The secondary is optional and is skipped entirely while the funnel route it
 * points at does not exist (slice 4/5) - linking a live page at a 404 to keep a
 * layout symmetrical is not a trade worth making.
 */
export function CTABanner({
  title,
  body,
  waMessage,
  waLabel = "Talk to us on WhatsApp",
  secondary,
}: {
  title: string;
  body: React.ReactNode;
  waMessage: string;
  waLabel?: string;
  /** Rendered only when `requiresFunnel` is false or the funnel has shipped. */
  secondary?: { href: string; label: string; requiresFunnel?: boolean };
}) {
  const showSecondary =
    secondary && (!secondary.requiresFunnel || FUNNEL_LIVE);

  return (
    <div className="rounded-lg border border-border bg-accent-subtle p-6 sm:p-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-xl font-semibold text-text">{title}</p>
          <p className="mt-2 text-lg text-text-muted">{body}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <WhatsAppCta message={waMessage} size="lg">
            {waLabel}
          </WhatsAppCta>
          {showSecondary ? (
            <ButtonLink href={secondary.href} variant="secondary" size="lg">
              {secondary.label}
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </div>
  );
}
