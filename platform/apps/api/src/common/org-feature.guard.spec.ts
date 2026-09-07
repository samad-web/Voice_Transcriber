/**
 * `OrgFeatureGuard` - enforces the client's own feature switchboard
 * (migration 0101) on the routes that ARE a feature.
 *
 * ── WHAT THESE TESTS ARE PROTECTING ─────────────────────────────────────────
 *
 * Not an authorization boundary - the guard's own header is explicit that the
 * same people who reach a gated route can switch the feature back on. What is
 * being protected is the promise that OFF MEANS OFF: a switch that only tidied
 * the sidebar would leave every page reachable by bookmark and every server
 * action behind it live.
 *
 * The entitlement half IS a security property and is tested as one: a client
 * override must never be able to turn on a module the provider has not granted.
 * `call_intel` is the case that matters, because it is the right to read
 * verbatim transcripts of customers' phone calls.
 *
 * The database is faked, and the fake records the org it was asked about, so a
 * guard that read the right answer for the wrong tenant fails here rather than
 * satisfying a bare allow/deny assertion.
 */
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { DbService } from "../db/db.service";
import {
  ORG_A,
  ORG_B,
  adminKeyPrincipal,
  expectHttpError,
  makeExecutionContext,
} from "./guard-harness.spec";
import { OrgFeatureGuard, RequireFeature } from "./org-feature.guard";

/** Mirrors how the real controllers mount it: metadata at CLASS level. */
@RequireFeature("call_triage")
class TriageController {
  list(): void {}
}

@RequireFeature("quotations")
class QuotationsController {
  list(): void {}
}

class UngatedController {
  anything(): void {}
}

function fakeDb(
  modules: string[],
  overrides: Record<string, boolean> = {},
): { db: DbService; asked: string[] } {
  const asked: string[] = [];
  const db = {
    withOrg: async (orgId: string, fn: (client: unknown) => Promise<unknown>) => {
      asked.push(orgId);
      return fn({
        query: async () => ({ rows: [{ modules, overrides }] }),
      });
    },
  } as unknown as DbService;
  return { db, asked };
}

function contextFor(cls: new () => object, method: string, orgId = ORG_A) {
  const instance = new cls() as Record<string, (...args: never[]) => unknown>;
  const made = makeExecutionContext({
    principal: adminKeyPrincipal({ orgId }),
    handler: instance[method],
    cls,
  });
  (made.req as { tenantOrgId?: string }).tenantOrgId = orgId;
  return made.context;
}

describe("OrgFeatureGuard", () => {
  it("allows a route whose feature is on", async () => {
    const { db, asked } = fakeDb(["aura", "crm", "call_intel"]);
    const guard = new OrgFeatureGuard(new Reflector(), db);
    await expect(guard.canActivate(contextFor(TriageController, "list"))).resolves.toBe(true);
    // Asked about the PINNED tenant, not the principal's claim about itself.
    expect(asked).toEqual([ORG_A]);
  });

  it("ignores a route that declares no feature", async () => {
    // The guard is harmless where it is not wanted: no metadata, no query at
    // all - which is what lets it sit at class level on a controller whose
    // routes are not all one feature, should that ever be needed.
    const { db, asked } = fakeDb([]);
    const guard = new OrgFeatureGuard(new Reflector(), db);
    await expect(guard.canActivate(contextFor(UngatedController, "anything"))).resolves.toBe(true);
    expect(asked).toEqual([]);
  });

  it("refuses when the client switched the feature off", async () => {
    const { db } = fakeDb(["aura", "crm"], { quotations: false });
    const guard = new OrgFeatureGuard(new Reflector(), db);
    await expectHttpError(() => guard.canActivate(contextFor(QuotationsController, "list")), {
      type: ForbiddenException,
      message: "Quotations is switched off for this workspace.",
      status: 403,
    });
  });

  it("says something DIFFERENT when the feature is blocked by another", async () => {
    // Three refusals, three sentences. The person reading this needs to know
    // whether to call their provider, flip a different switch, or flip this
    // one - and "forbidden" answers none of those.
    const { db } = fakeDb(["aura", "crm"], { products: false });
    const guard = new OrgFeatureGuard(new Reflector(), db);
    await expectHttpError(() => guard.canActivate(contextFor(QuotationsController, "list")), {
      type: ForbiddenException,
      message: "Quotations needs Products, which is switched off for this workspace.",
      status: 403,
    });
  });

  it("says something different again when the module was never bought", async () => {
    const { db } = fakeDb(["aura"]);
    const guard = new OrgFeatureGuard(new Reflector(), db);
    await expectHttpError(() => guard.canActivate(contextFor(QuotationsController, "list")), {
      type: ForbiddenException,
      message: "Quotations is not part of your plan - contact your provider to enable it.",
      status: 403,
    });
  });

  it("REFUSES a client override that tries to turn on a module they do not hold", async () => {
    // The invariant the whole feature rests on. A row in `org_feature_settings`
    // saying `call_triage = true` for an org without `call_intel` grants
    // nothing - the entitlement is the ceiling and a customer cannot raise it.
    const { db } = fakeDb(["aura", "crm"], { call_log: true, call_triage: true });
    const guard = new OrgFeatureGuard(new Reflector(), db);
    await expectHttpError(() => guard.canActivate(contextFor(TriageController, "list")), {
      type: ForbiddenException,
      message: "Unmatched calls is not part of your plan - contact your provider to enable it.",
      status: 403,
    });
  });

  it("refuses rather than reading the whole product when no org is pinned", async () => {
    // Guard order is wrong - this ran before TenantGuard. A configuration bug,
    // and it must fail closed: reading features with no tenant would mean
    // asking RLS a question with no `app.org_id`.
    const { db } = fakeDb(["aura", "crm", "call_intel"]);
    const guard = new OrgFeatureGuard(new Reflector(), db);
    const instance = new TriageController();
    const made = makeExecutionContext({
      principal: adminKeyPrincipal(),
      handler: instance.list,
      cls: TriageController,
    });
    await expectHttpError(() => guard.canActivate(made.context), {
      type: UnauthorizedException,
      message: "tenant scope required",
      status: 401,
    });
  });

  it("asks about the tenant TenantGuard pinned, not another one", async () => {
    const { db, asked } = fakeDb(["aura", "crm", "call_intel"]);
    const guard = new OrgFeatureGuard(new Reflector(), db);
    await guard.canActivate(contextFor(TriageController, "list", ORG_B));
    expect(asked).toEqual([ORG_B]);
  });

  it("treats a missing organizations row as no modules at all", async () => {
    // Unreachable under a correct RLS context; fail-closed if it ever is not.
    const db = {
      withOrg: async (_orgId: string, fn: (client: unknown) => Promise<unknown>) =>
        fn({ query: async () => ({ rows: [] }) }),
    } as unknown as DbService;
    const guard = new OrgFeatureGuard(new Reflector(), db);
    await expectHttpError(() => guard.canActivate(contextFor(TriageController, "list")), {
      type: ForbiddenException,
      message: "Unmatched calls is not part of your plan - contact your provider to enable it.",
      status: 403,
    });
  });
});
