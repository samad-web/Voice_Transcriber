import type { Branding } from "@aura/shared";

/**
 * The colour that marks WHICH TENANT the console is showing.
 *
 * ── WHY THIS IS NOT A STATE COLOUR ──────────────────────────────────────────
 *
 * The console's colour rule (packages/ui/src/state.tsx) spends red, green,
 * blue-as-outgoing and orange on call state and nothing else. A tenant marker
 * must never borrow them, or a person holding two tenants learns that "the red
 * one" is a customer rather than a missed call.
 *
 * So there are two sources, in order:
 *
 *   1. The tenant's own `branding.primaryColor`. It already paints that
 *      console's chrome, so the marker agrees with everything around it. Used
 *      only for a swatch and a hairline - never as a surface text sits on,
 *      because a tenant's hex has no contrast guarantee.
 *   2. Otherwise one of the four `--color-label-*` ramps (violet, teal, plum,
 *      steel), which exist precisely as non-state category colours and carry
 *      checked text contrast in both themes. Picked by a stable hash of the org
 *      id, so a tenant keeps its colour across sessions and devices.
 *
 * Four ramps means two unbranded tenants can share a colour. That is why the
 * marker is never colour alone: the name and the monogram or logo sit beside it.
 */

export const TENANT_LABEL_RAMPS = ["violet", "teal", "plum", "steel"] as const;
export type TenantLabelRamp = (typeof TENANT_LABEL_RAMPS)[number];

export interface TenantAccent {
  /** A CSS colour for the swatch dot and the header hairline. */
  swatch: string;
  /** Monogram tile background and foreground - always a checked label pair. */
  tileBg: string;
  tileFg: string;
  ramp: TenantLabelRamp;
  branded: boolean;
}

/** FNV-1a over the id - stable, dependency-free, and spreads uuids evenly enough for four buckets. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tenantAccent(orgId: string, branding: Branding = {}): TenantAccent {
  const ramp = TENANT_LABEL_RAMPS[hash(orgId) % TENANT_LABEL_RAMPS.length];
  const hex = branding.primaryColor?.trim();
  return {
    swatch: hex || `var(--color-label-${ramp}-text)`,
    tileBg: `var(--color-label-${ramp})`,
    tileFg: `var(--color-label-${ramp}-text)`,
    ramp,
    branded: Boolean(hex),
  };
}

/** Up to two letters for the monogram: "RD Interlock Brick" → "RI", "Acme" → "AC". */
export function tenantInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
