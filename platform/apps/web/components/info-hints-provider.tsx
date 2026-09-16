"use client";

import { useTransition } from "react";
import type { ReactNode } from "react";
import { InfoHintsProvider as UiInfoHintsProvider } from "@aura/ui";
import { setInfoHintsAction } from "@/lib/info-hints-actions";

/**
 * Seeds `@aura/ui`'s `InfoHintsProvider` from the `aura_info_hints` cookie
 * read on the server, and saves every flip back to it - the same split
 * `ThemeProvider` uses, and for the same reason: the switch itself must be
 * instant, so persistence rides in the background rather than gating it.
 */
export function InfoHintsProvider({
  initialEnabled,
  children,
}: {
  initialEnabled: boolean;
  children: ReactNode;
}) {
  const [, startTransition] = useTransition();

  return (
    <UiInfoHintsProvider
      initialEnabled={initialEnabled}
      onChange={(next) => startTransition(() => void setInfoHintsAction(next))}
    >
      {children}
    </UiInfoHintsProvider>
  );
}
