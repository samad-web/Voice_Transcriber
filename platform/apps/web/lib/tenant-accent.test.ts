import { describe, expect, it } from "vitest";
import { TENANT_LABEL_RAMPS, tenantAccent, tenantInitials } from "./tenant-accent";

const ORG_A = "423dcf03-7af9-47bd-adfe-337a4ac97034";
const ORG_B = "dfc7abea-db08-48a5-a991-30c679402203";

describe("tenantAccent", () => {
  it("is stable for the same org - a tenant keeps its colour", () => {
    expect(tenantAccent(ORG_A)).toEqual(tenantAccent(ORG_A));
  });

  it("uses only the non-state label ramps when the tenant is unbranded", () => {
    const accent = tenantAccent(ORG_B);
    expect(TENANT_LABEL_RAMPS).toContain(accent.ramp);
    expect(accent.swatch).toBe(`var(--color-label-${accent.ramp}-text)`);
    expect(accent.branded).toBe(false);
    // Never a state token (packages/ui/src/state.tsx).
    for (const value of [accent.swatch, accent.tileBg, accent.tileFg]) {
      expect(value).not.toMatch(/danger|success|orange|outgoing|accent|kpi/);
    }
  });

  it("prefers the tenant's own primary colour for the swatch, but never for the text tile", () => {
    const accent = tenantAccent(ORG_A, { primaryColor: "#0F766E" });
    expect(accent.swatch).toBe("#0F766E");
    expect(accent.branded).toBe(true);
    expect(accent.tileFg).toMatch(/^var\(--color-label-/);
  });

  it("spreads different orgs across more than one ramp", () => {
    const ramps = new Set(
      Array.from({ length: 40 }, (_, i) =>
        tenantAccent(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).ramp,
      ),
    );
    expect(ramps.size).toBeGreaterThan(1);
  });
});

describe("tenantInitials", () => {
  it("takes the first letters of the first two words", () => {
    expect(tenantInitials("RD Interlock Brick")).toBe("RI");
    expect(tenantInitials("fortune innovatives")).toBe("FI");
  });
  it("takes two letters of a single word, and survives an empty name", () => {
    expect(tenantInitials("Acme")).toBe("AC");
    expect(tenantInitials("   ")).toBe("?");
  });
});
