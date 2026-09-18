import { StudioBudget } from "./studio-budget";

describe("StudioBudget", () => {
  it("grants runs up to the limit, then refuses with the wait in minutes", () => {
    let now = 0;
    const budget = new StudioBudget(2, () => now);
    expect(budget.take("org-a")).toBeNull();
    now = 10 * 60_000;
    expect(budget.take("org-a")).toBeNull();
    // The oldest run was at t=0, so a slot frees up at t=60min: 50 minutes away.
    expect(budget.take("org-a")).toBe(50);
  });

  it("frees a run once the oldest one is an hour old", () => {
    let now = 0;
    const budget = new StudioBudget(1, () => now);
    expect(budget.take("org-a")).toBeNull();
    now = 60 * 60_000;
    expect(budget.take("org-a")).toBeNull();
  });

  it("keeps each organisation's budget separate", () => {
    const budget = new StudioBudget(1, () => 0);
    expect(budget.take("org-a")).toBeNull();
    expect(budget.take("org-b")).toBeNull();
    expect(budget.take("org-a")).not.toBeNull();
  });

  it("never reports a zero-minute wait", () => {
    let now = 0;
    const budget = new StudioBudget(1, () => now);
    budget.take("org-a");
    now = 60 * 60_000 - 1;
    expect(budget.take("org-a")).toBe(1);
  });
});
