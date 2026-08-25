import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMAIL_BODY_MAX,
  EMAIL_SUBJECT_MAX,
  MESSAGE_BODY_MAX,
  MESSAGE_TEMPLATES,
  MESSAGE_TEMPLATE_KEYS,
  PLACEHOLDER_HELP,
  capitalizeName,
  fillTemplate,
  firstNameOf,
  getMessageTemplateSpec,
  getTemplateFallback,
  placeholdersIn,
  titleNameOf,
  validateTemplateBody,
  validateTemplateSubject,
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

    it("drops a trailing optional placeholder that ends the message", () => {
      // {{reschedule_link}} usually sits at the very end with no full stop
      // after it. The original regex demanded a terminator, so an un-minted
      // link at end-of-string would have been left as the neutral word — i.e.
      // "Pick a new time: there" on somebody's phone.
      const out = fillTemplate("Sorry we missed you. Pick a new time: {{reschedule_link}}", {});
      expect(out).toBe("Sorry we missed you.");
    });

    it("keeps it when the link exists", () => {
      const out = fillTemplate("Sorry we missed you. Pick a new time: {{reschedule_link}}", {
        reschedule_link: "https://aura.example/reschedule/abc",
      });
      expect(out).toContain("https://aura.example/reschedule/abc");
    });
  });
});

describe("titleNameOf", () => {
  it("puts the chosen salutation in front of the whole name", () => {
    // The WHOLE name, not a guessed surname — in this funnel's market the last
    // word is often a father's name or an initial, so "Mr. Kumar" is a coin
    // flip where "Mr. Ramesh Kumar" is always right.
    expect(titleNameOf("mr", "ramesh kumar")).toBe("Mr. Ramesh Kumar");
    expect(titleNameOf("dr", "Priya S")).toBe("Dr. Priya S");
  });

  it("gives nothing back when they chose not to say", () => {
    // 'other' is "prefer not to say" — inventing "Mr." for them is the exact
    // failure the option exists to avoid.
    expect(titleNameOf("other", "Ramesh Kumar")).toBeUndefined();
    expect(titleNameOf(null, "Ramesh Kumar")).toBeUndefined();
    expect(titleNameOf(undefined, "Ramesh Kumar")).toBeUndefined();
  });

  it("degrades through firstNameOf to the neutral word, never to a blank", () => {
    // The seam that actually reaches a phone. Three steps down, no hole.
    const body = "Hi {{title_name}}, thanks.";
    const withTitle = titleNameOf("mr", "Ramesh Kumar") ?? firstNameOf("Ramesh Kumar");
    expect(fillTemplate(body, { title_name: withTitle })).toBe("Hi Mr. Ramesh Kumar, thanks.");

    const noTitle = titleNameOf(null, "Ramesh Kumar") ?? firstNameOf("Ramesh Kumar");
    expect(fillTemplate(body, { title_name: noTitle })).toBe("Hi Ramesh, thanks.");

    const nothing = titleNameOf(null, "R") ?? firstNameOf("R");
    expect(fillTemplate(body, { title_name: nothing })).toBe("Hi there, thanks.");
  });
});

describe("capitalizeName", () => {
  it("capitalises the first letter of each word", () => {
    // The case this exists for: a name typed on a phone keyboard.
    expect(capitalizeName("aakash kummar")).toBe("Aakash Kummar");
    expect(capitalizeName("imam")).toBe("Imam");
  });

  it("leaves the rest of each word exactly as typed", () => {
    // Lowercasing the remainder would fix "AAKASH" and break all of these.
    // Getting somebody's name wrong in the first word of a sales message is
    // worse than leaving it shouty.
    expect(capitalizeName("McDonald")).toBe("McDonald");
    expect(capitalizeName("D'Souza")).toBe("D'Souza");
    expect(capitalizeName("MD Imran")).toBe("MD Imran");
    expect(capitalizeName("AAKASH")).toBe("AAKASH");
  });

  it("handles names that are already correct", () => {
    expect(capitalizeName("Ramesh Kumar")).toBe("Ramesh Kumar");
  });

  it("does not corrupt scripts without letter case", () => {
    // This funnel is Tamil-Nadu facing, so a name in Tamil is ordinary input
    // rather than an edge case. It must come back byte-identical.
    expect(capitalizeName("ராமேஷ் குமார்")).toBe("ராமேஷ் குமார்");
  });

  it("survives empty and whitespace input", () => {
    expect(capitalizeName("")).toBe("");
    expect(capitalizeName("   ")).toBe("   ");
  });
});

describe("firstNameOf", () => {
  it("takes the first word", () => {
    expect(firstNameOf("Ramesh Kumar")).toBe("Ramesh");
  });

  it("capitalises it", () => {
    // The seam that actually reaches a phone: the greeting in every template.
    expect(firstNameOf("aakash kummar")).toBe("Aakash");
    expect(fillTemplate("Hi {{first_name}},", { first_name: firstNameOf("aakash") })).toBe(
      "Hi Aakash,",
    );
  });

  it("leaves the neutral fallback lower case", () => {
    // "Hi There," would be the capitalisation rule leaking somewhere it does
    // not belong — `there` is an ordinary word mid-sentence, not a name.
    expect(fillTemplate("Hi {{first_name}},", { first_name: firstNameOf("R") })).toBe("Hi there,");
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
    expect(validateTemplateBody("rejected", "Hi {{first_name}}, no thanks.", "whatsapp")).toEqual({
      ok: true,
    });
  });

  it("rejects {{slot}} outside the booking stage", () => {
    // The one that matters: no other stage has a booked time, so this would
    // render as "there" on every send — a message that looks fine in the editor
    // and is nonsense on the phone.
    const result = validateTemplateBody("rejected", "See you at {{slot}}.", "whatsapp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("{{slot}}");
  });

  it("accepts {{slot}} in the booking stage", () => {
    expect(validateTemplateBody("booking_confirmed", "At {{slot}}.", "whatsapp")).toEqual({
      ok: true,
    });
  });

  it("names every available placeholder when it rejects one", () => {
    // The error is read by an operator mid-edit, so it has to say what they CAN
    // use, not only what they cannot.
    const result = validateTemplateBody("rejected", "{{company}}", "whatsapp");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("{{first_name}}");
      expect(result.error).toContain("{{name}}");
    }
  });

  it("rejects an empty body and points at the off switch instead", () => {
    const result = validateTemplateBody("rejected", "   ", "whatsapp");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("switch it off");
  });

  it("rejects an over-long body", () => {
    expect(validateTemplateBody("rejected", "x".repeat(MESSAGE_BODY_MAX + 1), "whatsapp").ok).toBe(
      false,
    );
    expect(validateTemplateBody("rejected", "x".repeat(MESSAGE_BODY_MAX), "whatsapp").ok).toBe(true);
  });

  it("rejects an unknown stage", () => {
    expect(validateTemplateBody("not_a_stage", "Hello.", "whatsapp").ok).toBe(false);
  });

  it("gives email a longer ceiling than WhatsApp", () => {
    // The WhatsApp cap is a deliverability limit on an unofficial gateway, not
    // a style rule. Applying it to mail would force the email copy into the
    // wrong register for the channel.
    const long = "x".repeat(MESSAGE_BODY_MAX + 1);
    expect(validateTemplateBody("rejected", long, "whatsapp").ok).toBe(false);
    expect(validateTemplateBody("rejected", long, "email").ok).toBe(true);
    expect(validateTemplateBody("rejected", "x".repeat(EMAIL_BODY_MAX + 1), "email").ok).toBe(false);
  });

  it("refuses email copy for a WhatsApp-only stage", () => {
    // reminder_call_5m has no email variant on purpose — five minutes is not
    // enough notice for mail. Storing copy for it would be copy nothing reads.
    const result = validateTemplateBody("reminder_call_5m", "Hello.", "email");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("WhatsApp only");
  });
});

describe("validateTemplateSubject", () => {
  it("accepts a plain subject", () => {
    expect(validateTemplateSubject("booking_confirmed", "Your call is confirmed")).toEqual({
      ok: true,
    });
  });

  it("accepts a placeholder the stage allows", () => {
    expect(validateTemplateSubject("booking_confirmed", "Confirmed for {{slot}}")).toEqual({
      ok: true,
    });
  });

  it("rejects a line break, which is a header-injection attempt", () => {
    const result = validateTemplateSubject("booking_confirmed", "Hi\nBcc: someone@else");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("line break");
  });

  it("rejects an empty or over-long subject", () => {
    expect(validateTemplateSubject("booking_confirmed", "  ").ok).toBe(false);
    expect(
      validateTemplateSubject("booking_confirmed", "x".repeat(EMAIL_SUBJECT_MAX + 1)).ok,
    ).toBe(false);
  });

  it("rejects a stage with no email variant", () => {
    expect(validateTemplateSubject("reminder_call_5m", "Hello").ok).toBe(false);
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
      expect([spec.key, validateTemplateBody(spec.key, spec.whatsapp, "whatsapp")]).toEqual([
        spec.key,
        { ok: true },
      ]);
      if (spec.email) {
        expect([spec.key, validateTemplateBody(spec.key, spec.email.body, "email")]).toEqual([
          spec.key,
          { ok: true },
        ]);
        expect([spec.key, validateTemplateSubject(spec.key, spec.email.subject)]).toEqual([
          spec.key,
          { ok: true },
        ]);
      }
    }
  });

  it("resolves a fallback for every channel a stage claims to support", () => {
    for (const spec of MESSAGE_TEMPLATES) {
      expect([spec.key, getTemplateFallback(spec.key, "whatsapp")?.body]).toEqual([
        spec.key,
        spec.whatsapp,
      ]);
      // undefined for a WhatsApp-only stage is the correct answer, not a hole —
      // it is what tells the drain to dead-letter an email row for that stage
      // instead of sending a blank.
      expect([spec.key, getTemplateFallback(spec.key, "email")?.body]).toEqual([
        spec.key,
        spec.email?.body,
      ]);
    }
  });

  it("gives every email variant a subject", () => {
    // A blank subject line is the single strongest spam signal a message can
    // carry, and it is invisible in an editor that only shows the body.
    for (const spec of MESSAGE_TEMPLATES) {
      if (spec.email) expect([spec.key, spec.email.subject.trim().length > 0]).toEqual([spec.key, true]);
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
