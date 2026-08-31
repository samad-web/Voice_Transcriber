import { describe, expect, it } from "vitest";
import { blankNonCode, matchDelimiter } from "./source-scan";

/**
 * Self-tests for the scanner every guard-mounting suite in this app depends
 * on. Necessary for the same reason `apps/api` ships `guard-harness.spec.ts`
 * with its own: a silently wrong scanner weakens every assertion built on it
 * at once, and it fails OPEN - a function body it truncates before the guard
 * call is reported as unguarded; one it over-extends is reported as guarded.
 */
describe("blankNonCode - the scanner every guard-mounting suite rests on", () => {
  it("blanks a template literal's interpolations, braces included", () => {
    const out = blankNonCode("const u = `${API}/v1/calls/${id}`;");
    expect(out).toHaveLength("const u = `${API}/v1/calls/${id}`;".length);
    expect(out).not.toContain("{");
    expect(out).toContain("`");
  });

  it("blanks an apostrophe inside a block comment without eating the rest", () => {
    const src = "function f(\n  /** the environment's id */\n  a: string,\n) {\n  return a;\n}";
    const out = blankNonCode(src);
    expect(out).toContain("return a;");
    expect(matchDelimiter(out, out.indexOf("("), "(", ")")).toBeGreaterThan(0);
  });

  it("blanks a commented-out call so a mention cannot satisfy a guard check", () => {
    const out = blankNonCode("// await requireOperator();\nconst x = 1;");
    expect(out).not.toContain("requireOperator");
    expect(out).toContain("const x = 1;");
  });

  it("preserves offsets and line count exactly", () => {
    const src = 'const a = "xx"; // note\n/* block */ const b = `yy`;\n';
    const out = blankNonCode(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
  });
});
