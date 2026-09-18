import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplyDrafterConfig } from "@aura/shared";
import {
  draftReply,
  finishReply,
  REPLY_MAX_CHARS,
  REPLY_TRANSCRIPT_LIMIT,
  replyPrompt,
  type ReplyDraftInput,
} from "./reply";

const config = ReplyDrafterConfig.parse({});

const input = (overrides: Partial<ReplyDraftInput> = {}): ReplyDraftInput => ({
  instructions: "Invite them for a site visit. Offer a 50% discount.",
  config,
  source: { kind: "call", transcript: "Customer: How much for 5000 bricks? Agent: Rs 30 each." },
  businessName: "RD Interlock",
  ...overrides,
});

describe("replyPrompt", () => {
  it("puts the no-invented-commitments rule before the tenant's guidance, and says it wins", () => {
    const prompt = replyPrompt(input());
    expect(prompt.indexOf("Never invent or change a price")).toBeLessThan(
      prompt.indexOf("<<<GUIDANCE"),
    );
    expect(prompt).toMatch(/rule 1 always wins/);
  });

  it("fences the tenant's guidance as data", () => {
    expect(replyPrompt(input())).toContain(
      "<<<GUIDANCE\nInvite them for a site visit. Offer a 50% discount.\nGUIDANCE>>>",
    );
  });

  it("asks for the customer's language unless told to write English", () => {
    expect(replyPrompt(input())).toMatch(/language the customer used/);
    expect(replyPrompt(input({ config: { ...config, language: "english" } }))).toMatch(
      /Write in English/,
    );
  });

  it("keeps the END of a long call, where the next step is agreed", () => {
    const transcript = `${"a".repeat(REPLY_TRANSCRIPT_LIMIT)}THE-END`;
    const prompt = replyPrompt(input({ source: { kind: "call", transcript } }));
    expect(prompt).toContain("THE-END");
    expect(prompt).not.toContain("a".repeat(REPLY_TRANSCRIPT_LIMIT + 1));
  });

  it("renders a conversation as Customer/Business turns", () => {
    const prompt = replyPrompt(
      input({
        source: {
          kind: "conversation",
          channel: "whatsapp",
          messages: [
            { direction: "incoming", body: "Price for 5000?", occurredAt: null },
            { direction: "outgoing", body: "Rs 30 each", occurredAt: null },
          ],
        },
      }),
    );
    expect(prompt).toContain("Customer: Price for 5000?\nBusiness: Rs 30 each");
  });

  it("only names the customer when the CRM knows them", () => {
    expect(replyPrompt(input())).not.toMatch(/The customer's name is/);
    expect(replyPrompt(input({ customerName: "Ravi" }))).toMatch(/The customer's name is Ravi\./);
  });
});

describe("finishReply", () => {
  it("appends a configured sign-off the model forgot", () => {
    expect(finishReply("Thanks!", { ...config, signOff: "- Priya" })).toBe("Thanks!\n- Priya");
  });

  it("does not repeat a sign-off the model already wrote", () => {
    expect(finishReply("Thanks!\n- Priya", { ...config, signOff: "- Priya" })).toBe(
      "Thanks!\n- Priya",
    );
  });

  it("strips wrapping quotes and caps the length", () => {
    expect(finishReply('"Hello there"', config)).toBe("Hello there");
    expect(finishReply("x".repeat(REPLY_MAX_CHARS + 50), config)).toHaveLength(REPLY_MAX_CHARS);
  });
});

describe("draftReply (stub provider)", () => {
  beforeEach(() => {
    process.env.ANALYZE_STUB = "1";
  });
  afterEach(() => {
    delete process.env.ANALYZE_STUB;
  });

  it("returns text and nothing else - there is no send in this function", async () => {
    const res = await draftReply(
      input({ customerName: "Ravi", config: { ...config, signOff: "- Team" } }),
    );
    expect(res.provider).toBe("stub");
    expect(res.reply).toMatch(/^Hi Ravi, /);
    expect(res.reply.endsWith("- Team")).toBe(true);
  });
});
