import { evolutionInstanceName } from "./evolution-instance-name";

const ORG = "423dcf03-7af9-47bd-adfe-337a4ac97034";
const USER = "8c1abdc6-1111-4222-8333-444455556666";

describe("evolutionInstanceName", () => {
  it("reads as the workspace and the person, not as uuids", () => {
    const name = evolutionInstanceName({
      instance: "Sirah Digital",
      person: "Samad",
      orgId: ORG,
      userId: USER,
    });
    expect(name).toMatch(/^AURA-Sirah-Digital-Samad-[0-9a-f]{4}$/);
    // The whole reason this exists: the old form was 78 characters.
    expect(name.length).toBeLessThan(40);
  });

  it("gives the same person the same name every time", () => {
    const once = evolutionInstanceName({ instance: "A", person: "B", orgId: ORG, userId: USER });
    const twice = evolutionInstanceName({ instance: "A", person: "B", orgId: ORG, userId: USER });
    expect(once).toBe(twice);
  });

  it("separates two tenants that chose the same names", () => {
    // The collision that matters: the relay is shared, and two instances with
    // one name is one tenant's WhatsApp answering another's.
    const a = evolutionInstanceName({ instance: "Main", person: "Sam", orgId: ORG, userId: USER });
    const b = evolutionInstanceName({
      instance: "Main",
      person: "Sam",
      orgId: "11111111-2222-4333-8444-555555555555",
      userId: USER,
    });
    expect(a).not.toBe(b);
  });

  it("folds accents instead of dropping the letters", () => {
    const name = evolutionInstanceName({
      instance: "Café",
      person: "José",
      orgId: ORG,
      userId: USER,
    });
    expect(name).toContain("Cafe");
    expect(name).toContain("Jose");
  });

  it("survives punctuation, spacing and emoji", () => {
    const name = evolutionInstanceName({
      instance: "  R&D / Interlock  ",
      person: "O'Brien 🎉",
      orgId: ORG,
      userId: USER,
    });
    // No leading, trailing or doubled dashes anywhere in a segment.
    expect(name).not.toMatch(/--/);
    expect(name).toMatch(/^AURA-[A-Za-z0-9-]+-[0-9a-f]{4}$/);
  });

  it("still names something when the workspace or person is unknown", () => {
    const name = evolutionInstanceName({
      instance: null,
      person: null,
      orgId: ORG,
      userId: USER,
    });
    expect(name).toMatch(/^AURA-workspace-user-[0-9a-f]{4}$/);
  });

  it("caps a very long workspace name", () => {
    const name = evolutionInstanceName({
      instance: "A".repeat(200),
      person: "B".repeat(200),
      orgId: ORG,
      userId: USER,
    });
    expect(name.length).toBeLessThan(64);
  });
});
