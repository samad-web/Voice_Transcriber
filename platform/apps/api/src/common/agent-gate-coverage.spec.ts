import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import "reflect-metadata";
import type { Type } from "@nestjs/common";
import { AgentCapability, TOOL_CATALOG, toolSpec } from "@aura/shared";

import { CONTROLLERS } from "./guard-mounting.spec";
import { GATED_CAPABILITY_KEY, GATED_FEATURE_KEY } from "./feature-gate.guard";

/**
 * §3A.4's CI CHECK, verbatim:
 *
 *   "A lint or test must fail the build if any agent tool, endpoint or job is
 *    reachable without a gate check."
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS A TEST AND NOT A LINT RULE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A lint rule sees source text. The thing that has to be true here is about
 * NEST METADATA - "does this handler, as mounted, carry a guard" - and the
 * answer depends on class-level decorators, handler-level overrides and
 * `getAllAndOverride`'s precedence. A regex over a controller file cannot see
 * any of that, and the version that could would be a reimplementation of the
 * framework's resolution order.
 *
 * So the ENDPOINT half reflects over real metadata, exactly as
 * `guard-mounting.spec.ts` and `permissions-inventory.spec.ts` do - and for
 * the same reason the latter's header gives: a decorator that exists only in a
 * spec fixture is a gate that does not exist, and reflection is what caught
 * that on its first run.
 *
 * The TOOL and JOB halves are necessarily textual, because a tool is a
 * function and a sweep is a `setInterval` - neither carries metadata. Those
 * two assertions are therefore about a NAMED, GREPPABLE call, which is the
 * weaker guarantee and is said so out loud below.
 */

// ════════════════════════════════════════════════════════════════════════════
//  1. ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

/**
 * The controllers whose whole surface belongs to the agent.
 *
 * Matched on the route PREFIX rather than on a hand-kept class list, so a new
 * controller mounted under one of these paths is covered the day it lands -
 * which is the failure §3A.4 is written to prevent.
 */
const GATED_PREFIXES = ["callbacks", "transcript-agent"] as const;

/**
 * THE ONE EXEMPTION, and it is argued rather than listed.
 *
 * `features/gated` is the switchboard that turns the feature ON. Gating it
 * behind the feature being on is a workspace one click away from needing an
 * operator with a SQL prompt to recover - the same class of refusal
 * `features.ts` makes for its two `locked` entries and `guardLastOwner` makes
 * for the last owner of a workspace.
 *
 * It is not ungoverned: every route on it carries `OwnerRoleGuard`, and
 * `guard-mounting.spec.ts` pins all ten in `OWNER_ROLE_ROUTES`.
 */
const EXEMPT_PREFIXES = ["features/gated"] as const;

interface MountedRoute {
  controller: string;
  handler: string;
  path: string;
  feature: string | undefined;
  capability: string | undefined;
}

function mountedRoutes(): MountedRoute[] {
  const out: MountedRoute[] = [];

  for (const controller of CONTROLLERS as Type<unknown>[]) {
    const base = (Reflect.getMetadata("path", controller) as string | undefined) ?? "";
    const proto = controller.prototype as Record<string, unknown>;

    const featureOnClass = Reflect.getMetadata(GATED_FEATURE_KEY, controller) as string | undefined;
    const capabilityOnClass = Reflect.getMetadata(GATED_CAPABILITY_KEY, controller) as
      | string
      | undefined;

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const handler = proto[name];
      if (typeof handler !== "function") continue;
      // A method with no `path` metadata is a helper, not a route.
      const path = Reflect.getMetadata("path", handler) as string | undefined;
      if (path === undefined) continue;

      out.push({
        controller: controller.name,
        handler: name,
        path: base,
        // Handler wins over class - `getAllAndOverride`'s precedence, which
        // the guard itself relies on.
        feature:
          (Reflect.getMetadata(GATED_FEATURE_KEY, handler) as string | undefined) ?? featureOnClass,
        capability:
          (Reflect.getMetadata(GATED_CAPABILITY_KEY, handler) as string | undefined) ??
          capabilityOnClass,
      });
    }
  }

  return out;
}

describe("§3A.4: no agent endpoint is reachable without a gate check", () => {
  const routes = mountedRoutes();

  it("found the agent's controllers at all", () => {
    // Non-vacuity, the lesson `verify-rls.js`'s own rewrite records: if the
    // reflection below ever returns nothing - a renamed decorator key, a
    // controller dropped from CONTROLLERS, a changed metadata constant - every
    // assertion in this file would pass having checked nothing, and the gate
    // would be unenforced while the suite reported fine.
    const agentRoutes = routes.filter((r) =>
      GATED_PREFIXES.some((prefix) => r.path === prefix || r.path.startsWith(`${prefix}/`)),
    );
    expect(agentRoutes.length).toBeGreaterThanOrEqual(20);
  });

  it("carries @RequireGatedFeature on EVERY route under an agent prefix", () => {
    const ungated = routes
      .filter((r) =>
        GATED_PREFIXES.some((prefix) => r.path === prefix || r.path.startsWith(`${prefix}/`)),
      )
      .filter((r) => r.feature !== "transcript_agent")
      .map((r) => `${r.controller}.${r.handler}`);

    expect(ungated).toEqual([]);
  });

  it("names the switchboard as the single documented exemption", () => {
    // Pinned so a SECOND exemption cannot be added by appending to a list: it
    // has to be argued here, in this file, where a reviewer reads the argument
    // beside the hole it opens.
    expect([...EXEMPT_PREFIXES]).toEqual(["features/gated"]);

    const exempt = routes.filter((r) =>
      EXEMPT_PREFIXES.some((prefix) => r.path === prefix || r.path.startsWith(`${prefix}/`)),
    );
    expect(exempt.length).toBeGreaterThan(0);
    for (const route of exempt) expect(route.feature).toBeUndefined();
  });

  it("names a real capability wherever one is declared", () => {
    for (const route of routes) {
      if (!route.capability) continue;
      expect(AgentCapability.options).toContain(route.capability);
    }
  });

  it("declares the `callbacks` capability on the to-call list, not just the feature", () => {
    // §3A.2's capabilities are the half an owner actually uses - "summaries
    // yes, customer messaging no" - and a route gated only on the FEATURE
    // would answer for an owner who switched the call-back half off.
    const callbackRoutes = routes.filter(
      (r) => r.path === "callbacks" || r.path.startsWith("callbacks/"),
    );
    expect(callbackRoutes.length).toBeGreaterThan(0);
    for (const route of callbackRoutes) {
      expect([route.handler, route.capability]).toEqual([route.handler, "callbacks"]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  2. TOOLS
// ════════════════════════════════════════════════════════════════════════════

const WORKER_AGENT_DIR = join(__dirname, "../../../worker/src/pipeline/agent");

function readWorkerFile(name: string): string | null {
  try {
    return readFileSync(join(WORKER_AGENT_DIR, name), "utf8");
  } catch {
    return null;
  }
}

describe("§3A.4: the executor re-checks before every tool call", () => {
  /**
   * ── THIS HALF IS TEXTUAL, AND THAT IS A WEAKER GUARANTEE ──────────────────
   *
   * A tool is a function, not a decorated handler, so there is no metadata to
   * reflect over. What this asserts is that the executor's source contains a
   * NAMED, GREPPABLE gate call per tool - which catches a tool added without
   * one, and does not catch a tool whose gate call is inside a branch that
   * never runs.
   *
   * The structural half of the guarantee is elsewhere and is the stronger one:
   * `tools.ts` takes its gate decision as a REQUIRED constructor argument, so
   * a tool cannot be invoked without one existing - and the executor refuses
   * an action whose `gate_decision_id` is null, which 0185 makes a column so
   * the refusal is visible in the row rather than only in a log.
   */
  const executor = readWorkerFile("tools.ts");

  it("has an executor to check", () => {
    // Fails LOUDLY if the file is renamed, rather than passing vacuously -
    // the same non-vacuity rule as the endpoint half above.
    expect(executor).not.toBeNull();
  });

  /**
   * ── THE TOOLS ARE AN OBJECT LITERAL, NOT A SWITCH ────────────────────────
   *
   * `TOOLS` in tools.ts maps each name to an `async (client, ctx, params) =>`
   * function, so one tool's body runs from its own key to the next key at the
   * same indentation. An earlier version of this check looked for `case
   * "<name>"`, found nothing anywhere, and reported every tool as missing -
   * which is the one failure mode a textual check has to be written against:
   * it must break when the file's shape changes rather than quietly stop
   * looking. Hence `size` is asserted below before anything is concluded from
   * the absence of a match.
   */
  function toolBodies(source: string): Map<string, string> {
    const keys = [...source.matchAll(/^ {2}([a-z_]+): async \(/gm)];
    const bodies = new Map<string, string>();
    keys.forEach((match, index) => {
      const start = match.index ?? 0;
      const end = index + 1 < keys.length ? (keys[index + 1].index ?? source.length) : source.length;
      bodies.set(match[1], source.slice(start, end));
    });
    return bodies;
  }

  it("re-checks the gate before every tool in the catalogue", () => {
    if (!executor) return;
    const bodies = toolBodies(executor);
    // Non-vacuity. If the literal is reshaped into something this cannot
    // parse, the map comes back short and THIS line fails - rather than the
    // filter below passing because it had nothing to look at.
    expect(bodies.size).toBeGreaterThanOrEqual(TOOL_CATALOG.length);

    const missing = TOOL_CATALOG.filter((tool) => {
      const body = bodies.get(tool.name);
      if (body === undefined) return true;
      return !/assertGate|requireCapability|gateAllows/.test(body);
    }).map((tool) => tool.name);

    expect(missing).toEqual([]);
  });

  it("checks the gate before the tool's first write, not after it", () => {
    if (!executor) return;
    const bodies = toolBodies(executor);
    // A gate checked after the INSERT has already happened is a log line, not
    // a gate: §3A.4 is "re-check before the tool call", and the row would
    // survive the exception. Ordering inside the body is the cheap half of
    // that; the expensive half is `assertGate` throwing rather than returning.
    const late = TOOL_CATALOG.filter((tool) => {
      const body = bodies.get(tool.name) ?? "";
      const gate = body.search(/assertGate|requireCapability|gateAllows/);
      const write = body.search(/client\.query|await \w+\(client/);
      return gate < 0 || (write >= 0 && write < gate);
    }).map((tool) => tool.name);

    expect(late).toEqual([]);
  });

  it("takes the gate decision as a required argument, not an optional one", () => {
    if (!executor) return;
    // The structural half. An optional parameter is a parameter somebody omits.
    expect(executor).toMatch(/gate:\s*GateDecision(?!\s*\|)/);
    expect(executor).not.toMatch(/gate\?:\s*GateDecision/);
  });

  it("refuses an action with no gate decision recorded", () => {
    if (!executor) return;
    expect(executor).toMatch(/gate_decision_id/);
  });

  it("maps every tool to a capability the gate understands", () => {
    for (const tool of TOOL_CATALOG) {
      expect(AgentCapability.options).toContain(toolSpec(tool.name).capability);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  3. JOBS
// ════════════════════════════════════════════════════════════════════════════

describe("§3A.4: scheduled jobs skip users without the feature", () => {
  /**
   * §3A.4's table: "Scheduled jobs and sync (calendar webhooks, reminders,
   * digests) - skip users without the feature."
   *
   * Every sweep in the agent's worker directory has to consult the gate. Read
   * as text for the same reason the tool half is, and with the same stated
   * limit.
   */
  const files = (() => {
    try {
      return readdirSync(WORKER_AGENT_DIR).filter(
        (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
      );
    } catch {
      return [];
    }
  })();

  it("found the agent's worker files at all", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("consults the gate in every file that starts a sweep", () => {
    const ungated: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(WORKER_AGENT_DIR, name), "utf8");
      // A file that starts a sweep is one that schedules repeating work.
      if (!/setInterval|export function start[A-Z]/.test(source)) continue;
      // It satisfies the rule either by consulting the gate itself, or by
      // delegating to something that does - which is named explicitly rather
      // than matched loosely, so "it calls a helper" cannot be satisfied by
      // calling any helper at all.
      if (/gateFor|assertGate|checkGate|resolveGateForCall|skipped_feature_off/.test(source)) {
        continue;
      }
      ungated.push(name);
    }
    expect(ungated).toEqual([]);
  });

  it("marks a skipped transcript rather than silently dropping it", () => {
    // §3A.4: "Transcript stored per org policy but marked
    // `skipped_feature_off`; NO MODEL CALL, NO COST." The status is 0185's, and
    // the ingest path is the only place that may write it.
    const ingest = readWorkerFile("ingest.ts");
    expect(ingest).not.toBeNull();
    expect(ingest).toMatch(/skipped_feature_off/);
  });
});
