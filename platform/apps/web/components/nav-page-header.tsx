"use client";

import { PageHeader } from "./page-header";
import { useNavLabel } from "./nav-history-provider";

/**
 * A PageHeader titled with the page's name as THIS reader's rail shows it -
 * for a loading.tsx, whose heading must match the page it stands in for even
 * where the name depends on who is looking (nav.ts `roleLabels`).
 */
export function NavPageHeader({ href, fallback, context }: { href: string; fallback: string; context?: string }) {
  return <PageHeader title={useNavLabel(href, fallback)} context={context} />;
}
