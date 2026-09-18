import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES, AgentDefinition, type AgentDefinitionInput } from "@aura/shared";
import {
  blankField,
  callSampleLabel,
  formatTestValue,
  blankState,
  definitionFrom,
  editorStateFrom,
  humanizeKey,
  issueMessages,
  mintKeys,
} from "./agent-studio";

const stored: AgentDefinitionInput = {
  kind: "call_extractor",
  name: "Brick enquiry",
  purpose: "Bricks",
  instructions: "Read the call.",
  fields: [
    { key: "customer_name", type: "string", description: "Name", required: false },
    { key: "budget", type: "number", description: "Budget", required: true },
    {
      key: "brick_type",
      type: "enum",
      description: "Type",
      required: false,
      enumValues: ["solid", "hollow"],
    },
  ],
  leadRules: {
    requiredFields: ["brick_type"],
    anyFields: ["budget"],
    minFilled: 2,
    titleField: "customer_name",
    valueField: "budget",
    allowFailedValidation: true,
  },
};

describe("humanizeKey", () => {
  it("turns a key back into words", () => {
    expect(humanizeKey("customer_name")).toBe("Customer name");
    expect(humanizeKey("budget")).toBe("Budget");
  });
});

describe("a stored agent through the editor and back", () => {
  it("round-trips without losing a rule, a flag or an option", () => {
    const out = definitionFrom(editorStateFrom(stored, { savedKeys: true }));
    expect(out).toEqual(stored);
  });

  it("keeps a saved key even after the detail's name is edited", () => {
    const state = editorStateFrom(stored, { savedKeys: true });
    state.fields[0]!.name = "Who called";
    const out = definitionFrom(state);
    expect(out.fields?.[0]?.key).toBe("customer_name");
  });

  it("drops a card title that points at a removed detail instead of sending it", () => {
    const state = editorStateFrom(stored, { savedKeys: true });
    state.fields = state.fields.filter((f) => f.key !== "customer_name");
    const out = definitionFrom(state);
    expect(out.kind === "call_extractor" && out.leadRules?.titleField).toBeUndefined();
  });
});

describe("new details", () => {
  it("mint a key from the name, never colliding with a saved one", () => {
    const state = editorStateFrom(stored, { savedKeys: true });
    const added = { ...blankField(), name: "Budget" };
    state.fields.push(added);
    expect(mintKeys(state.fields).get(added.uid)).toBe("budget_2");
  });

  it("from a template are re-minted from their names, since nothing is saved yet", () => {
    const state = editorStateFrom(stored, { savedKeys: false });
    state.fields[0]!.name = "Caller";
    expect(definitionFrom(state).fields?.[0]?.key).toBe("caller");
  });

  it("carry lead rules that were set before the key existed", () => {
    const state = blankState("call_extractor");
    state.name = "New";
    state.instructions = "Read.";
    const field = { ...blankField(), name: "Site visit", type: "boolean" as const };
    state.fields.push(field);
    state.leadRules.roles[field.uid] = "required";
    const out = definitionFrom(state);
    expect(out.kind === "call_extractor" && out.leadRules?.requiredFields).toEqual(["site_visit"]);
    expect(AgentDefinition.safeParse(out).success).toBe(true);
  });

  it("fall back to the name when no description was written", () => {
    const state = blankState("chat_qualifier");
    state.fields.push({ ...blankField(), name: "Delivery city" });
    expect(definitionFrom(state).fields?.[0]?.description).toBe("Delivery city");
  });
});

describe("kinds without fields or rules", () => {
  it("sends a drafter's settings and nothing else", () => {
    const state = blankState("reply_drafter");
    state.name = "Follow-up";
    state.instructions = "Be kind.";
    state.replyConfig = { ...state.replyConfig, tone: "professional", signOff: "- Team" };
    const out = definitionFrom(state);
    expect(out).toEqual({
      kind: "reply_drafter",
      name: "Follow-up",
      purpose: "",
      instructions: "Be kind.",
      config: {
        tone: "professional",
        length: "short",
        language: "match_customer",
        signOff: "- Team",
      },
    });
    expect(AgentDefinition.safeParse(out).success).toBe(true);
  });
});

describe("every template", () => {
  it("survives the editor unchanged", () => {
    for (const template of AGENT_TEMPLATES) {
      const out = definitionFrom(editorStateFrom(template.definition, { savedKeys: false }));
      expect([template.id, AgentDefinition.safeParse(out).success]).toEqual([template.id, true]);
    }
  });
});

describe("callSampleLabel", () => {
  const base = {
    started_at: "2026-09-10T10:05:00Z",
    duration_s: 125,
    remote_name: null,
    remote_number_prefix: null,
    remote_number_last3: null,
    telecaller: null,
  };

  it("prefers the contact's name, then the visible digits", () => {
    expect(callSampleLabel({ ...base, remote_name: "Ravi" })).toMatch(/^Ravi · /);
    expect(
      callSampleLabel({ ...base, remote_number_prefix: "98765", remote_number_last3: "210" }),
    ).toMatch(/^98765…210 · /);
    expect(callSampleLabel(base)).toMatch(/^Unknown caller · /);
  });

  it("gives the length and whose phone it was", () => {
    expect(callSampleLabel({ ...base, telecaller: "Aakash" })).toMatch(/2m 5s · Aakash$/);
  });
});

describe("formatTestValue", () => {
  it("reads empty answers as nothing found", () => {
    for (const v of [null, undefined, "", "  ", []]) expect(formatTestValue(v)).toBeNull();
  });

  it("writes yes/no and lists as words", () => {
    expect(formatTestValue(true)).toBe("Yes");
    expect(formatTestValue(["solid", "hollow"])).toBe("solid, hollow");
  });
});

describe("issueMessages", () => {
  it("names the detail a problem belongs to", () => {
    const state = editorStateFrom(stored, { savedKeys: true });
    expect(
      issueMessages([{ path: ["fields", 1, "enumValues"], message: "needs options" }], state),
    ).toEqual(["Budget: needs options"]);
  });

  it("does not repeat the same sentence twice", () => {
    const state = blankState("call_extractor");
    expect(
      issueMessages(
        [
          { path: ["name"], message: "x" },
          { path: ["name"], message: "x" },
        ],
        state,
      ),
    ).toEqual(["x"]);
  });
});
