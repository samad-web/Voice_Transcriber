import { type AgentVersionRow, summarizeAgents } from "./agent-summaries";

const row = (overrides: Partial<AgentVersionRow>): AgentVersionRow => ({
  id: "a",
  version: 1,
  kind: "call_extractor",
  name: "Agent",
  purpose: "",
  workspace_id: "w",
  system_prompt: "",
  field_schema: { fields: [{}, {}] },
  lead_rules: {},
  config: {},
  labels: [],
  is_active: false,
  archived_at: null,
  created_at: "2026-09-01T00:00:00Z",
  ...overrides,
});

describe("summarizeAgents", () => {
  it("reports the latest version's name even when an older version is the one running", () => {
    const [summary] = summarizeAgents([
      row({ version: 1, name: "Old name", is_active: true, created_at: "2026-09-01T00:00:00Z" }),
      row({
        version: 2,
        name: "New name",
        created_at: "2026-09-05T00:00:00Z",
        field_schema: { fields: [{}] },
      }),
    ]);
    expect(summary).toMatchObject({
      name: "New name",
      latestVersion: 2,
      activeVersion: 1,
      versionCount: 2,
      fieldCount: 1,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-05T00:00:00Z",
    });
  });

  it("reports no active version when nothing is switched on", () => {
    expect(summarizeAgents([row({})])[0]?.activeVersion).toBeNull();
  });

  it("lists running agents first, then by name", () => {
    const order = summarizeAgents([
      row({ id: "1", name: "Alpha" }),
      row({ id: "2", name: "Zulu", is_active: true }),
      row({ id: "3", name: "Bravo" }),
    ]).map((s) => s.name);
    expect(order).toEqual(["Zulu", "Alpha", "Bravo"]);
  });

  it("counts no fields on a malformed schema rather than throwing", () => {
    expect(summarizeAgents([row({ field_schema: null })])[0]?.fieldCount).toBe(0);
  });
});
