import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_KIND_ORDER,
  AGENT_KIND_SPECS,
  AGENT_TEMPLATES,
  AgentDefinition,
  AgentKind,
  agentFieldKey,
  describeLeadRules,
  keepValidDetails,
  leadRulesProblems,
  parseReplyDrafterConfig,
  templatesFor,
} from "./agent-kinds";
import { LeadRules } from "./leads";

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

const extractor = (overrides: Record<string, unknown> = {}) => ({
  kind: "call_extractor",
  name: "Enquiries",
  instructions: "Read the call.",
  fields: [
    { key: "customer_name", type: "string", description: "Name" },
    { key: "budget", type: "number", description: "Budget" },
  ],
  ...overrides,
});

describe("agent kinds", () => {
  it("matches the database CHECK exactly - a kind the DB refuses, or never runs, is drift", () => {
    const matches = Array.from(
      SQL.matchAll(/ADD\s+CONSTRAINT\s+agents_kind_check\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi),
    );
    expect(matches.length).toBeGreaterThan(0);
    const last = matches[matches.length - 1][1];
    const inDb = Array.from(last.matchAll(/'([^']*)'/g), (m) => m[1]);
    expect(new Set(inDb)).toEqual(new Set(AgentKind.options));
  });

  it("describes and orders every kind", () => {
    expect(new Set(Object.keys(AGENT_KIND_SPECS))).toEqual(new Set(AgentKind.options));
    expect(new Set(AGENT_KIND_ORDER)).toEqual(new Set(AgentKind.options));
    expect(AGENT_KIND_ORDER).toHaveLength(AgentKind.options.length);
  });

  it("offers at least one template for every kind", () => {
    for (const kind of AgentKind.options) expect(templatesFor(kind).length).toBeGreaterThan(0);
  });

  it("ships only templates that save as they stand", () => {
    for (const template of AGENT_TEMPLATES) {
      const parsed = AgentDefinition.safeParse(template.definition);
      expect([template.id, parsed.success ? "ok" : parsed.error.issues]).toEqual([
        template.id,
        "ok",
      ]);
    }
    expect(new Set(AGENT_TEMPLATES.map((t) => t.id)).size).toBe(AGENT_TEMPLATES.length);
  });
});

describe("AgentDefinition", () => {
  it("accepts a minimal extractor and defaults its rules", () => {
    const parsed = AgentDefinition.parse(extractor());
    expect(parsed.kind).toBe("call_extractor");
    if (parsed.kind === "call_extractor") expect(parsed.leadRules).toEqual(LeadRules.parse({}));
  });

  it("refuses an extractor with nothing to extract", () => {
    expect(AgentDefinition.safeParse(extractor({ fields: [] })).success).toBe(false);
  });

  it("refuses two details with the same key - the second would overwrite the first", () => {
    const res = AgentDefinition.safeParse(
      extractor({
        fields: [
          { key: "budget", type: "number", description: "a" },
          { key: "budget", type: "string", description: "b" },
        ],
      }),
    );
    expect(res.success).toBe(false);
  });

  it("refuses lead rules that name a detail the agent never extracts", () => {
    const res = AgentDefinition.safeParse(extractor({ leadRules: { requiredFields: ["phone"] } }));
    expect(res.success).toBe(false);
  });

  it("refuses a reply drafter carrying fields", () => {
    const res = AgentDefinition.safeParse({
      kind: "reply_drafter",
      name: "Follow-up",
      instructions: "Be kind.",
      fields: [{ key: "x", type: "string", description: "x" }],
    });
    expect(res.success).toBe(false);
  });

  it("fills a drafter's settings with defaults", () => {
    const parsed = AgentDefinition.parse({
      kind: "reply_drafter",
      name: "F",
      instructions: "Be kind.",
    });
    expect(parsed.kind === "reply_drafter" && parsed.config).toEqual({
      tone: "friendly",
      length: "short",
      language: "match_customer",
      signOff: "",
    });
  });

  it("drops lead rules from a kind that has none, rather than storing them", () => {
    const parsed = AgentDefinition.parse({
      kind: "chat_qualifier",
      name: "Q",
      instructions: "We sell bricks.",
      leadRules: { requiredFields: ["x"] },
    });
    expect("leadRules" in parsed).toBe(false);
  });

  it("caps a qualifier's extra details lower than an extractor's", () => {
    const fields = Array.from({ length: 13 }, (_, i) => ({
      key: `f${i}`,
      type: "string",
      description: "x",
    }));
    expect(
      AgentDefinition.safeParse({ kind: "chat_qualifier", name: "Q", instructions: "x", fields })
        .success,
    ).toBe(false);
  });
});

describe("leadRulesProblems", () => {
  const fields = [
    { key: "name", type: "string" as const, description: "", required: false },
    { key: "budget", type: "number" as const, description: "", required: false },
  ];

  it("is empty for rules that fit the fields", () => {
    expect(
      leadRulesProblems(
        fields,
        LeadRules.parse({ anyFields: ["budget"], titleField: "name", valueField: "budget" }),
      ),
    ).toEqual([]);
  });

  it("refuses a deal value read from a text detail", () => {
    expect(leadRulesProblems(fields, LeadRules.parse({ valueField: "name" }))).toHaveLength(1);
  });

  it("refuses a floor no call could reach", () => {
    expect(leadRulesProblems(fields, LeadRules.parse({ minFilled: 3 }))).toHaveLength(1);
  });

  it("names every unknown detail", () => {
    const problems = leadRulesProblems(
      fields,
      LeadRules.parse({ requiredFields: ["phone"], anyFields: ["city"], titleField: "who" }),
    );
    expect(problems).toHaveLength(3);
  });
});

describe("describeLeadRules", () => {
  it("does not repeat a floor the other rules already imply", () => {
    expect(describeLeadRules(LeadRules.parse({ anyFields: ["need", "budget"] }))).toBe(
      "A call becomes a lead when at least one of need, budget is found.",
    );
  });

  it("states the default rule plainly", () => {
    expect(describeLeadRules(LeadRules.parse({}))).toBe(
      "A call becomes a lead when at least 1 detail is found.",
    );
  });

  it("says so when there is no rule at all", () => {
    expect(describeLeadRules(LeadRules.parse({ minFilled: 0 }))).toBe(
      "Every call that is read without errors becomes a lead.",
    );
  });

  it("uses the labels it is given", () => {
    const text = describeLeadRules(LeadRules.parse({ requiredFields: ["budget"] }), (k) =>
      k.toUpperCase(),
    );
    expect(text).toBe("A call becomes a lead when BUDGET is found.");
  });
});

describe("agentFieldKey", () => {
  it("derives snake_case from a label", () => {
    expect(agentFieldKey("Customer's budget (₹)", new Set())).toBe("customer_s_budget");
  });

  it("never collides with a key already taken", () => {
    expect(agentFieldKey("Budget", new Set(["budget", "budget_2"]))).toBe("budget_3");
  });

  it("produces a key the extraction schema accepts, even from digits or nothing", () => {
    for (const label of ["2 BHK", "", "!!!"]) {
      expect(agentFieldKey(label, new Set())).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("keepValidDetails", () => {
  const fields = [
    { key: "city", type: "string" as const, description: "", required: false },
    { key: "qty", type: "number" as const, description: "", required: false },
    { key: "urgent", type: "boolean" as const, description: "", required: false },
    {
      key: "size",
      type: "enum" as const,
      description: "",
      required: false,
      enumValues: ["small", "large"],
    },
    { key: "items", type: "string[]" as const, description: "", required: false },
  ];

  it("keeps answers that fit their detail", () => {
    expect(
      keepValidDetails(fields, {
        city: " Chennai ",
        qty: 500,
        urgent: false,
        size: "large",
        items: ["a", " "],
      }),
    ).toEqual({ city: "Chennai", qty: 500, urgent: false, size: "large", items: ["a"] });
  });

  it("drops a value that does not fit, without losing the rest", () => {
    expect(
      keepValidDetails(fields, { city: "Pune", qty: "ten lakh", size: "huge", urgent: "yes" }),
    ).toEqual({
      city: "Pune",
    });
  });

  it("ignores keys the qualifier never asked for, and anything that is not an object", () => {
    expect(keepValidDetails(fields, { name: "Ravi" })).toEqual({});
    expect(keepValidDetails(fields, null)).toEqual({});
    expect(keepValidDetails(fields, ["x"])).toEqual({});
  });
});

describe("parseReplyDrafterConfig", () => {
  it("falls back to defaults rather than throwing on stored garbage", () => {
    expect(parseReplyDrafterConfig({ tone: "rude" }).tone).toBe("friendly");
    expect(parseReplyDrafterConfig(null).length).toBe("short");
  });
});
