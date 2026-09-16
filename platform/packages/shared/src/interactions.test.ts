import { describe, expect, it } from "vitest";
import { InteractionInput } from "./interactions";

const CONTACT = "00000000-0000-4000-8000-0000000000c1";

describe("InteractionInput - hand-logged calls", () => {
  it("accepts a call with an outcome and no body", () => {
    expect(InteractionInput.safeParse({ type: "call", contactId: CONTACT, outcome: "no_answer" }).success).toBe(true);
  });

  it("refuses a call without an outcome", () => {
    expect(InteractionInput.safeParse({ type: "call", contactId: CONTACT, body: "rang them" }).success).toBe(false);
  });

  it("refuses an outcome on anything that is not a call", () => {
    expect(
      InteractionInput.safeParse({ type: "note", contactId: CONTACT, body: "x", outcome: "connected" }).success,
    ).toBe(false);
  });

  it("still requires content on a note, and still requires a parent", () => {
    expect(InteractionInput.safeParse({ type: "note", contactId: CONTACT }).success).toBe(false);
    expect(InteractionInput.safeParse({ type: "call", outcome: "busy" }).success).toBe(false);
  });
});
