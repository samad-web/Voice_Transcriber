import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MESSAGING_PROVIDERS,
  MessagingProvider,
  inboundNeedsForwardSecret,
  isMessagingProvider,
  isPersonalWhatsApp,
  isWabaProvider,
  providerSpec,
  providersForKind,
} from "./messaging-providers";

const MIGRATIONS_DIR = (() => {
  let dir = resolve(process.cwd());
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, "packages", "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("packages/db/migrations not found above " + process.cwd());
})();

const SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");

describe("messaging providers", () => {
  it("matches the database CHECK exactly - a provider the DB refuses is drift", () => {
    // Same guard `agent-kinds.test.ts` puts on `agents.kind`, and for the same
    // reason it gives: the notification-kind CHECK drifted from its zod enum
    // once already and threw 23514 in production. A provider the API accepts
    // and the database rejects is an insert that fails at the worst moment -
    // partway through connecting somebody's WhatsApp.
    const matches = Array.from(
      SQL.matchAll(
        /ADD\s+CONSTRAINT\s+messaging_channels_provider_check\s+CHECK\s*\(\s*provider\s+IN\s*\(([^)]*)\)/gi,
      ),
    );
    expect(matches.length).toBeGreaterThan(0);
    const last = matches[matches.length - 1][1];
    const inDb = Array.from(last.matchAll(/'([^']*)'/g), (m) => m[1]);
    expect(new Set(inDb)).toEqual(new Set(MessagingProvider.options));
  });

  it("has a spec for every enum member and no orphans", () => {
    expect(new Set(MESSAGING_PROVIDERS.map((p) => p.id))).toEqual(new Set(MessagingProvider.options));
  });

  describe("the split that was backwards", () => {
    it("files both ways of reaching a WABA under waba", () => {
      // The bug this module was written for. `wasi` is a Business Solution
      // Provider - Embedded Signup, a real WABA, approved templates - and it
      // was listed as the PERSONAL option in the integrations hub and
      // described in the console as needing no Meta approval.
      expect(providersForKind("waba").sort()).toEqual(["waba", "wasi"]);
      expect(isWabaProvider("wasi")).toBe(true);
      expect(isPersonalWhatsApp("wasi")).toBe(false);
    });

    it("files only the linked-device transport under personal", () => {
      expect(providersForKind("personal")).toEqual(["evolution"]);
      expect(isPersonalWhatsApp("evolution")).toBe(true);
      expect(isWabaProvider("evolution")).toBe(false);
    });

    it("does not call Instagram and Messenger a kind of WhatsApp", () => {
      expect(providerSpec("meta")?.accountKind).toBeNull();
      expect(isWabaProvider("meta")).toBe(false);
      expect(isPersonalWhatsApp("meta")).toBe(false);
    });
  });

  describe("what follows from the account kind", () => {
    it("gives every WABA templates and the session window, and the personal one neither", () => {
      // These two properties are the whole reason the distinction is
      // load-bearing rather than cosmetic: they decide whether the composer
      // shows a countdown and whether a template picker exists at all.
      for (const id of providersForKind("waba")) {
        const spec = providerSpec(id)!;
        expect(spec.hasTemplates).toBe(true);
        expect(spec.hasSessionWindow).toBe(true);
        expect(spec.requiresMetaApproval).toBe(true);
        expect(spec.unofficial).toBe(false);
      }
      const personal = providerSpec("evolution")!;
      expect(personal.hasTemplates).toBe(false);
      expect(personal.hasSessionWindow).toBe(false);
      expect(personal.requiresMetaApproval).toBe(false);
    });

    it("marks exactly one provider unofficial, and it is the personal one", () => {
      // The ban-risk warning in the console is rendered off this flag. If a
      // second provider ever sets it, that warning has to be read again rather
      // than inherited.
      const unofficial = MESSAGING_PROVIDERS.filter((p) => p.unofficial).map((p) => p.id);
      expect(unofficial).toEqual(["evolution"]);
    });

    it("only requires a forward secret where inbound is genuinely dropped without one", () => {
      // The false CRITICAL alert. Wasi signs every delivery and Aura discards
      // what it cannot verify; a personal relay authenticates on the webhook
      // token in the URL, so no secret is the normal working state.
      expect(inboundNeedsForwardSecret("wasi")).toBe(true);
      expect(inboundNeedsForwardSecret("evolution")).toBe(false);
      expect(inboundNeedsForwardSecret("waba")).toBe(false);
      expect(inboundNeedsForwardSecret("meta")).toBe(false);
    });
  });

  describe("unknown providers", () => {
    it("answers undefined rather than guessing a default", () => {
      // Deliberate: a plausible default would make an unrecognised provider
      // behave like `waba` somewhere, which is the silent wrongness this
      // module exists to remove. Every caller decides for itself.
      expect(providerSpec("meta_cloud")).toBeUndefined();
      expect(providerSpec("")).toBeUndefined();
      expect(providerSpec(null)).toBeUndefined();
      expect(providerSpec(undefined)).toBeUndefined();
      expect(isMessagingProvider("meta_cloud")).toBe(false);
    });

    it("is neither business nor personal, and needs no secret", () => {
      expect(isWabaProvider("something-new")).toBe(false);
      expect(isPersonalWhatsApp("something-new")).toBe(false);
      expect(inboundNeedsForwardSecret("something-new")).toBe(false);
    });
  });
});
