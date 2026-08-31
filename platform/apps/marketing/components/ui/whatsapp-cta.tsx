import { ButtonLink, type ButtonSize, type ButtonVariant } from "./button";
import { whatsappHref } from "@/lib/site";

/**
 * The primary CTA (doc 10 §2). A plain `wa.me` deep link - no widget, no SDK,
 * no third-party script, and therefore nothing in the JS budget and nothing to
 * declare in a privacy policy.
 *
 * When NEXT_PUBLIC_WHATSAPP_NUMBER is unset the component renders a disabled,
 * visibly-unconfigured control instead of a link to nowhere. A dead primary CTA
 * that *looks* live is the single worst failure mode this page has.
 */
export function WhatsAppCta({
  message,
  children = "Talk to us on WhatsApp",
  variant = "primary",
  size = "md",
  className,
}: {
  message: string;
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const href = whatsappHref(message);

  if (!href) {
    return (
      <span
        role="note"
        className="inline-flex items-center gap-2 rounded-md border border-dashed border-border-strong bg-bg-subtle px-4 py-2.5 text-sm text-text-muted"
      >
        <span aria-hidden="true">⚠</span>
        WhatsApp CTA unconfigured: set NEXT_PUBLIC_WHATSAPP_NUMBER
      </span>
    );
  }

  return (
    <ButtonLink href={href} external variant={variant} size={size} className={className}>
      {children}
    </ButtonLink>
  );
}
