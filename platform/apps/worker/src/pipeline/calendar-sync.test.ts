import { describe, expect, it } from "vitest";

import { attendeeContact, durationSeconds } from "./calendar-sync";
import type { NormalisedEvent } from "./calendar-providers";

/**
 * A calendar is more revealing than a mailbox, not less - the times and names
 * alone tell you about somebody's health, their beliefs, their childcare and
 * whether they are interviewing elsewhere. So the same rule the mail sync has
 * is pinned here just as explicitly, with the cases named rather than implied.
 */

const SELF = "rep@example.com";
const CONTACT = "priya@customer.com";
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";

const known = new Map([[CONTACT, CONTACT_ID]]);

function event(overrides: Partial<NormalisedEvent> = {}): NormalisedEvent {
  return {
    externalId: "e1",
    title: "Site visit",
    organizer: SELF,
    attendees: [SELF, CONTACT],
    startsAt: new Date("2026-08-13T09:00:00Z"),
    endsAt: new Date("2026-08-13T10:00:00Z"),
    location: "Client site",
    cancelled: false,
    ...overrides,
  };
}

describe("attendeeContact - what may enter the CRM", () => {
  it("records a meeting a known contact was invited to", () => {
    expect(attendeeContact(event(), SELF, known)).toBe(CONTACT_ID);
  });

  it("DROPS a meeting with nobody from the CRM on it", () => {
    const personal = event({
      title: "Dentist",
      attendees: [SELF, "reception@dentist.example"],
    });
    expect(attendeeContact(personal, SELF, known)).toBeNull();
  });

  it("drops a therapy appointment, a school evening and an interview", () => {
    const private_ = [
      "clinic@therapy.example",
      "office@school.example",
      "talent@competitor.example",
    ];
    for (const other of private_) {
      expect(attendeeContact(event({ attendees: [SELF, other] }), SELF, known)).toBeNull();
    }
  });

  it("drops an event the rep is alone in", () => {
    expect(attendeeContact(event({ attendees: [SELF] }), SELF, known)).toBeNull();
  });

  it("does not match the account against ITSELF, even if the rep is a contact", () => {
    // A colleague who was once a customer, or a test contact using the rep's
    // own address. Without the self-exclusion every private appointment in
    // that person's calendar would become a CRM record.
    const selfIsAContact = new Map([[SELF, "99999999-9999-4999-8999-999999999999"]]);
    expect(attendeeContact(event({ attendees: [SELF] }), SELF, selfIsAContact)).toBeNull();
  });

  it("is case-insensitive about the account's own address", () => {
    expect(attendeeContact(event({ attendees: [SELF] }), "REP@Example.com", known)).toBeNull();
  });

  it("drops everything when the org has no contacts at all", () => {
    expect(attendeeContact(event(), SELF, new Map())).toBeNull();
  });

  it("finds a contact among a long guest list", () => {
    const big = event({
      attendees: [SELF, "a@other.example", "b@other.example", CONTACT, "c@other.example"],
    });
    expect(attendeeContact(big, SELF, known)).toBe(CONTACT_ID);
  });

  it("matches a cancelled event too - that is how the removal path finds it", () => {
    // attendeeContact must NOT filter cancellations out: the sync needs the
    // contact match to know which timeline row to delete.
    expect(attendeeContact(event({ cancelled: true }), SELF, known)).toBe(CONTACT_ID);
  });
});

describe("durationSeconds", () => {
  it("measures a normal meeting", () => {
    expect(durationSeconds(event())).toBe(3600);
  });

  it("returns null when the provider gave no end time", () => {
    expect(durationSeconds(event({ endsAt: null }))).toBeNull();
  });

  it("returns null rather than a negative duration when the times are backwards", () => {
    const broken = event({
      startsAt: new Date("2026-08-13T10:00:00Z"),
      endsAt: new Date("2026-08-13T09:00:00Z"),
    });
    expect(durationSeconds(broken)).toBeNull();
  });

  it("returns null for a zero-length event rather than 0", () => {
    const instant = event({ endsAt: new Date("2026-08-13T09:00:00Z") });
    expect(durationSeconds(instant)).toBeNull();
  });
});
