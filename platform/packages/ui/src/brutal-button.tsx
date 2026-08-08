import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button } from "./button";

/** Old variant names, kept so ~20 apps/web call sites keep type-checking. */
const VARIANT_ALIAS = {
  primary: "primary",
  secondary: "secondary",
  destructive: "danger",
} as const;

/**
 * @deprecated Use `Button`. This is a compatibility shim for the design-system
 * v2 migration and is **deleted in slice 2** (`Build docs/16_DESIGN_SYSTEM_V2_AND_FUNNEL.md`
 * §5), once the last `apps/web` route group has been migrated.
 *
 * It is a wrapper rather than `export { Button as BrutalButton }` for one
 * concrete reason: the old API's third variant is called `destructive` and the
 * new one calls it `danger`. A bare re-export would narrow the accepted union
 * and break `tsc` at four call sites the moment this landed — exactly the
 * "console stops compiling" outcome the staged migration exists to avoid.
 *
 * `shadow` is accepted and ignored. The `4px 4px 0 rgba(0,0,0,1)` offset shadow
 * is retired with the brutalist system; keeping the prop in the signature means
 * no call site has to change before slice 2 touches it anyway.
 */
export function BrutalButton({
  children,
  variant = "primary",
  shadow: _shadow = false,
  className = "",
  ...rest
}: {
  children: ReactNode;
  variant?: keyof typeof VARIANT_ALIAS;
  shadow?: boolean;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button variant={VARIANT_ALIAS[variant]} size="md" className={className} {...rest}>
      {children}
    </Button>
  );
}
