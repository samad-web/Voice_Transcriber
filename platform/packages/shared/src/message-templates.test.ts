import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MESSAGE_BODY_MAX,
  MESSAGE_TEMPLATES,
  MESSAGE_TEMPLATE_KEYS,
  PLACEHOLDER_HELP,
  fillTemplate,
  firstNameOf,
  getMessageTemplateSpec,
  placeholdersIn,
  validateTemplateBody,
} from "./message-templates";

/**
 * These are the only tests standing between an edited template and a message
 * sent to a real person, because the path from the console to WhatsApp has no
 * other checkpoint: the API validates with `validateTemplateBody` and the worker
 * renders with `fillTemplate`, and both are here.
 */

describe("fillTemplate", () => {
  it("substitutes the values it is given", () => {
    expect(fillTemplate("Hi {{first_name}}, at {{slot}}.", { first_name: "Ramesh", slot: "6pm" }))
      .toBe("Hi Ramesh, at 6pm.");
  });

  it("tolerates spacing inside the braces", () => {
    expect(fillTemplate("Hi {{ first_name }}.", { first_name: "Ramesh" })).toBe("Hi Ramesh.");
  });

  it("NEVER leaves braces in the output", () => {
    // The failure this prevents is literal `{{slot}}` arriving on somebody's
    // phone. Every unresolved placeholder becomes a neutral word instead.
    const out = fillTemplate("Hi {{first_name}}, at {{slot}}, {{unknown}}.", {});
    expect(out).not.toMatch(/\{\{|\}\}/);
    expect(out).toBe("Hi there, at there, there.");
  });

  it("falls back to a word, not an empty string", () => {
    // "Hi , thanks for your interest" is the tell that nobody typed this.
    for (const value of [undefined, "", "   "]) {
      expect(fillTemplate("Hi {{first_name}},", { first_name: value })).toBe("Hi there,");
    }
  });

  it("trims the values it substitutes", () => {
    expect(fillTemplate("Hi {{first_name}},", { first_name: "  Ramesh  " })).toBe("Hi Ramesh,");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(fillTemplate("{{name}} / {{name}}", { name: "R K" })).toBe("R K / R K");
  });

  describe("optional placeholders drop their sentence", () => {
    // {{meet_link}} only exists when Google Calendar produced one. Falling back
    // to the neutral word would send "Join here: there ." to a real customer,
    // which is worse than saying nothing about joining at all.
    const body =
      "Hi {{first_name}}, your call is confirmed for {{slot}}. " +
      "Join here: {{meet_link}} . If that stops working, reply here.";

    it("keeps the sentence when the link exists", () => {
      const out = fillTemplate(body, {
        first_name: "Ramesh",
        slot: "Tue 6:30 pm",
        meet_link: "https://meet.google.com/abc-defg-hij",
      });
      expect(out).toContain("https://meet.google.com/abc-defg-hij");
      expect(out).toContain("If that stops working");
    });

    it("removes the whole sentence when it does not", () => {
      const out = fillTemplate(body, { first_name: "Ramesh", slot: "Tue 6:30 pm" });
      expect(out).toBe("Hi Ramesh, your call is confirmed for Tue 6:30 pm. If that stops working, reply here.");
      // The two failures this guards against, stated explicitly.
      expect(out).not.toContain("there");
      expect(out).not.toContain("Join here");
    });

    it("leaves no double space where the sentence was", () => {
      const out = fillTemplate(body, { first_name: "Ramesh", slot: "Tue 6:30 pm" });
      expect(out).not.toMatch(/ {2,}/);
    });
  });
});

describe("firstNameOf", () => {
  it("takes the first word", () => {
    expect(firstNameOf("Ramesh Kumar")).toBe("Ramesh");
  });

  it("rejects a single letter, which reads as a broken mail merge", () => {
    expect(firstNameOf("R Kumar")).toBeUndefined();
  });

  it("returns undefined for nothing usable", () => {
    expect(firstNameOf("")).toBeUndefined();
    expect(firstNameOf("   ")).toBeUndefined();
  });

  it("hands fillTemplate something that ends up neutral, never blank", () => {
    // The two functions are only ever used together; this is the seam.
    const body = "Hi {{first_name}}, thanks.";
    expect(fillTemplate(body, { first_name: firstNameOf("R") })).toBe("Hi there, thanks.");
    expect(fillTemplate(body, { first_name: firstNameOf("Ramesh Kumar") })).toBe(
      "Hi Ramesh, thanks.",
    );
  });
});

describe("placeholdersIn", () => {
  it("dedupes and preserves first-appearance order", () => {
    expect(placeholdersIn("{{name}} {{slot}} {{name}}")).toEqual(["name", "slot"]);
  });

  it("finds nothing in plain text", () => {
    expect(placeholdersIn("Hi there, thanks.")).toEqual([]);
  });
});

describe("validateTemplateBody", () => {
  it("accepts a body using only that stage's placeholders", () => {
    expect(validateTemplateBody("rejected", "Hi {{first_name}}, no thanks.")).toEqual({ ok: true });
  });

  it("rejects {{slot}} outside the booking stage", () => {
    // The one that matters: no other stage has a booked time, so this would
    // render as "there" on every send — a message that looks fine in the editor
    // and is nonsense on the phone.
    const result = validateTemplateBody("rejected", "See you at {{slot}}.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("{{slot}}");
  });

  it("accepts {{slot}} in the booking stage", () => {
    expect(validateTemplateBody("booking_confirmed", "At {{slot}}.")).toEqual({ ok: true });
  });

  it("names every available placeholder when it rejects one", () => {
    // The error is read by an operator mid-edit, so it has to say what they CAN
    // use, not only what they cannot.
    const result = validateTemplateBody("rejected", "{{company}}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("{{first_name}}");
      expect(result.error).toContain("{{name}}");
    }
  });

  it("rejects an empty body and points at the off switch instead", () => {
    const result = validateTemplateBody("rejected", "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("switch it off");
  });

  it("rejects an over-long body", () => {
    expect(validateTemplateBody("rejected", "x".repeat(MESSAGE_BODY_MAX + 1)).ok).toBe(false);
    expect(validateTemplateBody("rejected", "x".repeat(MESSAGE_BODY_MAX)).ok).toBe(true);
  });

  it("rejects an unknown stage", () => {
    expect(validateTemplateBody("not_a_stage", "Hello.").ok).toBe(false);
  });
});

describe("the catalogue", () => {
  it("has one spec per key, in the same order", () => {
    expect(MESSAGE_TEMPLATES.map((t) => t.key)).toEqual([...MESSAGE_TEMPLATE_KEYS]);
  });

  it("every built-in body passes its own validator", () => {
    // Catches the obvious own goal: shipping a default that the API would
    // refuse to save, so an operator cannot re-save it after a one-word edit.
    for (const spec of MESSAGE_TEMPLATES) {
      expect([spec.key, validateTemplateBody(spec.key, spec.whatsapp)]).toEqual([
        spec.key,
        { ok: true },
      ]);
    }
  });

  it("every placeholder a stage allows is documented", () => {
    for (const spec of MESSAGE_TEMPLATES) {
      for (const p of spec.allowedPlaceholders) {
        expect([spec.key, p, typeof PLACEHOLDER_HELP[p]]).toEqual([spec.key, p, "string"]);
      }
    }
  });

  it("every stage that is not live explains why", () => {
    // The badge is worthless without the sentence under it. A stage marked
    // not-live with no reason renders an empty warning box.
    for (const spec of MESSAGE_TEMPLATES) {
      if (!spec.live) expect([spec.key, Boolean(spec.blockedBy)]).toEqual([spec.key, true]);
    }
  });

  it("resolves a spec by key and refuses an unknown one", () => {
    expect(getMessageTemplateSpec("rejected")?.label).toBe("Rejected");
    expect(getMessageTemplateSpec("nope")).toBeUndefined();
  });

  it("keeps every body short enough for a chat message", () => {
    // Not a style preference: Evolution drives an ordinary WhatsApp account
    // over the unofficial web protocol, and long uniform business messages are
    // what gets one flagged.
    for (const spec of MESSAGE_TEMPLATES) {
      expect([spec.key, spec.whatsapp.length < 400]).toEqual([spec.key, true]);
    }
  });
});

describe("the migration seed matches the built-in copy", () => {
  /**
   * Migration 0026 seeds these same five bodies into
   * `marketing.message_templates`, and this file holds them as the fallback.
   * Two copies of the same sentences, and nothing else notices when they
   * diverge — an edit here would give a freshly-migrated environment different
   * "original wording" from an existing one, and "Restore original" would put
   * back copy that was never what the database had.
   */
  // EVERY migration, not just 0026. A seeded body can legitimately be changed
  // by a later migration (0029 rewrote booking_confirmed to offer the Meet
  // link), and pinning to the original file would report drift the moment that
  // happened correctly.
  const dir = join(__dirname, "..", "..", "db", "migrations");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

  // Collapse SQL string concatenation (`'part one ' ||\n 'part two'`) into one
  // literal, THEN unescape doubled quotes. Order matters: unescaping first
  // could produce a quote the join pattern then misreads.
  const seeded = sql.replace(/'\s*\|\|\s*\r?\n\s*'/g, "").replace(/''/g, "'");

  it.each(MESSAGE_TEMPLATES.map((t) => [t.key, t.whatsapp] as const))(
    "%s",
    (_key, body) => {
      expect(seeded).toContain(body);
    },
  );
});
