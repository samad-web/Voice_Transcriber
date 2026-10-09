/**
 * The organization chart's API surface (migrations 0177/0178,
 * Build docs/org-chart-build-plan.md §15).
 *
 * No database - `DbService` is a fake that records every statement. What is
 * under test is the behaviour neither the guards nor the shared unit tests can
 * express:
 *
 *  · §4.3's integrity rules on the WRITE path - a cycle refused with a usable
 *    message, a second root refused, a delete blocked while reports remain,
 *    and the ORDER of the two statements a move makes (close, then insert),
 *    which is what keeps it from colliding with the unique index;
 *  · that history is never overwritten - the SQL a move and a replacement
 *    issue is an UPDATE of `effective_to`/`end_date` plus an INSERT, never an
 *    UPDATE of `manager_position_id` or `user_id`;
 *  · §7's permission split, read off the controllers' real decorator metadata:
 *    every contract route on `employment_contract`, every other route on
 *    `position`, which is what makes M7's "a telecaller cannot retrieve any
 *    contract data" true before a handler runs;
 *  · §7's redaction and logging MUSTs - a signed URL is short-lived, and
 *    every document read writes `document_access_log`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ORG_A, USER_A, sessionPrincipal } from "../../common/guard-harness.spec";
import {
  CRM_PERMISSION_KEY,
  type CrmPermissionRequirement,
} from "../../common/crm-permissions.guard";
import { UNSCOPED } from "../../common/crm-scope";
import type { DbService } from "../../db/db.service";
import type { S3Service } from "../../s3/s3.service";
import { OrgChartContractsController } from "./org-chart-contracts.controller";
import { OrgChartController } from "./org-chart.controller";
import { OrgChartPositionsController } from "./org-chart-positions.controller";

const CEO = "00000000-0000-4000-8000-00000000c001";
const SALES = "00000000-0000-4000-8000-00000000c002";
const REP = "00000000-0000-4000-8000-00000000c003";
const CONTRACT = "00000000-0000-4000-8000-00000000c011";
const DOCUMENT = "00000000-0000-4000-8000-00000000c012";
const TODAY = "2026-10-09";

interface Issued {
  text: string;
  values: unknown[];
}

/**
 * A fake client that answers by matching on the SQL's shape.
 *
 * Keyed on distinctive fragments rather than on call order, because the
 * controllers legitimately reorder their reads - and a fake that depends on
 * order turns a harmless refactor into a red suite, which is how a test
 * becomes something people delete rather than trust.
 */
function fakeDb(
  opts: {
    roots?: string[];
    managerOf?: string | null;
    reports?: string[];
    cycle?: boolean;
    positionMissing?: boolean;
    member?: boolean;
    frozen?: boolean;
    openPrimary?: { id: string; user_id: string } | null;
    contract?: Record<string, unknown> | null;
    document?: Record<string, unknown> | null;
    settings?: Record<string, unknown> | null;
  } = {},
) {
  const issued: Issued[] = [];

  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });

      if (text.includes("CURRENT_DATE::text")) return { rows: [{ today: TODAY }], rowCount: 1 };
      if (text.includes("FROM org_chart_settings")) {
        return { rows: opts.settings ? [opts.settings] : [], rowCount: opts.settings ? 1 : 0 };
      }
      // `requirePosition`
      if (text.includes("SELECT id::text AS id, title FROM positions")) {
        if (opts.positionMissing) return { rows: [], rowCount: 0 };
        const id = values[0] as string;
        const titles: Record<string, string> = {
          [CEO]: "Chief Executive",
          [SALES]: "Head of Sales",
          [REP]: "Sales Rep",
        };
        return { rows: [{ id, title: titles[id] ?? "A position" }], rowCount: 1 };
      }
      // `requireMember`
      if (text.includes("JOIN memberships m ON m.user_id = u.id")) {
        return opts.member === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: USER_A, name: "Priya", email: "priya@example.com" }], rowCount: 1 };
      }
      // `rootPositionIds`
      if (text.includes("NOT EXISTS") && text.includes("FROM positions p")) {
        return { rows: (opts.roots ?? []).map((id) => ({ id })), rowCount: (opts.roots ?? []).length };
      }
      // `managerOf`
      if (text.includes("SELECT manager_position_id") && text.includes("ORDER BY effective_from DESC")) {
        return opts.managerOf
          ? { rows: [{ manager_position_id: opts.managerOf }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // `wouldCycleInDb`
      if (text.includes("WITH RECURSIVE up(id, depth)")) {
        return opts.cycle ? { rows: [{ hit: SALES }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // `assertDeletable`
      if (text.includes("WHERE manager_position_id = $1") && text.includes("FROM reporting_lines")) {
        const reports = opts.reports ?? [];
        return { rows: reports.map((position_id) => ({ position_id })), rowCount: reports.length };
      }
      if (text.includes("status = 'frozen' AS frozen")) {
        return { rows: [{ frozen: opts.frozen ?? false }], rowCount: 1 };
      }
      // the replacement UPDATE in `assign`
      if (text.includes("UPDATE position_assignments") && text.includes("RETURNING id::text AS id, user_id")) {
        return opts.openPrimary
          ? { rows: [opts.openPrimary], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("UPDATE reporting_lines") && text.includes("RETURNING manager_position_id")) {
        return opts.managerOf
          ? { rows: [{ manager_position_id: opts.managerOf }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO position_assignments")) {
        return { rows: [{ id: "assignment-1" }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO positions")) return { rows: [{ id: REP }], rowCount: 1 };
      if (text.includes("INSERT INTO reporting_lines")) return { rows: [{ id: "line-1" }], rowCount: 1 };
      if (text.includes("INSERT INTO employment_contracts")) {
        return { rows: [{ id: CONTRACT }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO contract_documents")) {
        return { rows: [{ id: DOCUMENT, version: 2 }], rowCount: 1 };
      }
      if (text.includes("FROM contract_documents d") && text.includes("JOIN employment_contracts c")) {
        return opts.document
          ? { rows: [opts.document], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM employment_contracts c")) {
        return opts.contract ? { rows: [opts.contract], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT user_id::text AS user_id FROM employment_contracts")) {
        return opts.contract ? { rows: [{ user_id: USER_A }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("DELETE FROM positions")) return { rows: [], rowCount: 1 };
      // Everything else - inserts into the two logs, the replace-list deletes,
      // the notification write.
      return { rows: [], rowCount: 1 };
    }),
  };

  const db = {
    withOrg: (async (_orgId: string, fn: (c: unknown) => Promise<unknown>) => fn(client)) as never,
    adminPool: (() => {
      throw new Error("the org chart never uses the admin pool");
    }) as never,
  } as unknown as DbService;

  return { db, client, issued };
}

const s3 = {
  presignedPutUrl: jest.fn(async () => "https://example.test/put"),
  presignedGetUrl: jest.fn(async () => "https://example.test/get"),
} as unknown as S3Service;

const req = (over: Record<string, unknown> = {}) =>
  ({ principal: sessionPrincipal(), ip: "203.0.113.7", ...over }) as never;

describe("the organization chart's permission split (§7, M7)", () => {
  /**
   * Read off the REAL decorator metadata, the technique
   * permissions-inventory.spec.ts uses - a grep over source can be satisfied
   * by a decorator inside a comment and cannot see class-level inheritance.
   */
  const pairsFor = (controller: { prototype: object }): Map<string, string> => {
    const out = new Map<string, string>();
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const handler = proto[name];
      if (typeof handler !== "function") continue;
      const required = Reflect.getMetadata(CRM_PERMISSION_KEY, handler) as
        | CrmPermissionRequirement
        | undefined;
      if (required) out.set(name, `${required.objectType}:${required.action}`);
    }
    return out;
  };

  it("puts EVERY contract route on employment_contract and nothing else", () => {
    // The module's one serious failure mode: a decorator copied from the
    // positions controller would hand the whole floor every salary, and
    // nothing else in the system would notice.
    const pairs = pairsFor(OrgChartContractsController);
    expect(pairs.size).toBeGreaterThan(0);
    for (const [handler, pair] of pairs) {
      expect([handler, pair.split(":")[0]]).toEqual([handler, "employment_contract"]);
    }
  });

  it("puts NO chart or position route on employment_contract", () => {
    for (const controller of [OrgChartController, OrgChartPositionsController]) {
      for (const [handler, pair] of pairsFor(controller)) {
        expect([handler, pair.split(":")[0]]).toEqual([handler, "position"]);
      }
    }
  });

  it("asks only for view, create and edit on contracts - never delete or export", () => {
    // §6.5's timeline and a dispute about what was signed both need the row to
    // survive, and nothing emits contracts in bulk. A cell with no route
    // behind it is a checkbox somebody might believe.
    const actions = new Set([...pairsFor(OrgChartContractsController).values()]);
    expect([...actions].sort()).toEqual([
      "employment_contract:create",
      "employment_contract:edit",
      "employment_contract:view",
    ]);
  });

  it("gates the write routes on create/edit/delete and the reads on view", () => {
    const pairs = pairsFor(OrgChartPositionsController);
    expect(pairs.get("one")).toBe("position:view");
    expect(pairs.get("create")).toBe("position:create");
    expect(pairs.get("update")).toBe("position:edit");
    expect(pairs.get("remove")).toBe("position:delete");
    expect(pairs.get("move")).toBe("position:edit");
    expect(pairs.get("assign")).toBe("position:edit");
    expect(pairs.get("unassign")).toBe("position:edit");
    // §14's manager route is the one deliberate exception - its authorization
    // is the relationship check inside the handler, which a route-level guard
    // cannot express. See its own header.
    expect(pairs.get("setResponsibilitiesAsManager")).toBe("position:view");
  });

  it("never names a compensation column in the chart or directory reads", () => {
    /**
     * §7: "no sensitive fields in the chart payload for unauthorized roles".
     *
     * The strongest form of that is a payload with no sensitive fields in it
     * AT ALL, so there is no redaction branch to get wrong - and this asserts
     * it against the source rather than against a response shape, because the
     * failure would arrive as somebody widening a SELECT.
     *
     * `employment_type` is deliberately permitted: the directory reads exactly
     * that one column, only for a caller holding `employment_contract:view`,
     * and §6.6 lists it as a column.
     */
    const source = readFileSync(join(__dirname, "org-chart.controller.ts"), "utf8");
    expect(source).not.toMatch(/comp_fixed_num|comp_currency|comp_structure/);
    expect(source).not.toMatch(/notice_period_days/);
  });
});

describe("§4.3 no cycles, on the write path", () => {
  it("refuses a move under the position's own report, naming both", () => {
    const { db } = fakeDb({ managerOf: CEO, cycle: true });
    const controller = new OrgChartPositionsController(db);
    return expect(
      controller.move(req(), ORG_A, SALES, {
        newManagerPositionId: REP,
        effectiveDate: "2026-11-01",
      }),
    ).rejects.toThrow(ConflictException);
  });

  it("explains which position has to move first", async () => {
    const { db } = fakeDb({ managerOf: CEO, cycle: true });
    const controller = new OrgChartPositionsController(db);
    await expect(
      controller.move(req(), ORG_A, SALES, {
        newManagerPositionId: REP,
        effectiveDate: "2026-11-01",
      }),
    ).rejects.toThrow(/cannot report to it/);
  });

  it("closes the old line BEFORE inserting the new one", async () => {
    // The order is the whole point: `reporting_lines_one_open_solid` is a
    // unique index over open solid lines, so an insert that came first would
    // collide with the line it is replacing.
    const { db, issued } = fakeDb({ managerOf: CEO });
    const controller = new OrgChartPositionsController(db);
    await controller.move(req(), ORG_A, SALES, {
      newManagerPositionId: REP,
      effectiveDate: "2026-11-01",
    });

    const close = issued.findIndex(
      (q) => q.text.includes("UPDATE reporting_lines") && q.text.includes("effective_to"),
    );
    const insert = issued.findIndex((q) => q.text.includes("INSERT INTO reporting_lines"));
    expect(close).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(close);
  });

  it("closes the old line the DAY BEFORE the effective date", async () => {
    // `coversDate` is inclusive at both ends, so closing it ON the effective
    // date would leave two solid managers covering that day.
    const { db, issued } = fakeDb({ managerOf: CEO });
    const controller = new OrgChartPositionsController(db);
    await controller.move(req(), ORG_A, SALES, {
      newManagerPositionId: REP,
      effectiveDate: "2026-11-01",
    });
    const close = issued.find((q) => q.text.includes("effective_to = ($2::date - 1)"));
    expect(close).toBeTruthy();
    expect(close?.values).toContain("2026-11-01");
  });

  it("NEVER updates manager_position_id in place", async () => {
    // §4.3: never overwrite history. An UPDATE of the manager would make every
    // as-of view before the move show the new structure.
    const { db, issued } = fakeDb({ managerOf: CEO });
    const controller = new OrgChartPositionsController(db);
    await controller.move(req(), ORG_A, SALES, {
      newManagerPositionId: REP,
      effectiveDate: "2026-11-01",
    });
    for (const q of issued) {
      expect(q.text).not.toMatch(/SET\s+manager_position_id/);
    }
  });

  it("writes both logs with the effective date and the reason", async () => {
    const { db, issued } = fakeDb({ managerOf: CEO });
    const controller = new OrgChartPositionsController(db);
    await controller.move(req(), ORG_A, SALES, {
      newManagerPositionId: REP,
      effectiveDate: "2026-11-01",
      reason: "South region split.",
    });
    const change = issued.find((q) => q.text.includes("INSERT INTO org_change_log"));
    const audit = issued.find((q) => q.text.includes("INSERT INTO audit_log"));
    expect(change?.values).toContain("South region split.");
    expect(change?.values).toContain("2026-11-01");
    expect(audit?.values).toContain("org_chart.reporting_line.move");
  });

  it("does nothing at all when the manager has not changed", async () => {
    // A no-op write would close and reopen an identical line, putting a
    // meaningless "moved" entry in the timeline on every accidental drop-back.
    const { db, issued } = fakeDb({ managerOf: CEO });
    const controller = new OrgChartPositionsController(db);
    const result = await controller.move(req(), ORG_A, SALES, {
      newManagerPositionId: CEO,
      effectiveDate: "2026-11-01",
    });
    expect(result).toEqual({ ok: true, unchanged: true });
    expect(issued.some((q) => q.text.includes("INSERT INTO reporting_lines"))).toBe(false);
    expect(issued.some((q) => q.text.includes("INSERT INTO org_change_log"))).toBe(false);
  });

  it("refuses to promote a non-root seat to root", async () => {
    const { db } = fakeDb({ roots: [CEO], managerOf: CEO });
    const controller = new OrgChartPositionsController(db);
    await expect(
      controller.move(req(), ORG_A, SALES, {
        newManagerPositionId: null,
        effectiveDate: "2026-11-01",
      }),
    ).rejects.toThrow(ConflictException);
  });
});

describe("§4.3 one root", () => {
  it("allows the first position to be created with no manager", async () => {
    // §5.3's first-run state: "create your first position (the owner/root)".
    const { db } = fakeDb({ roots: [] });
    const controller = new OrgChartPositionsController(db);
    await expect(controller.create(req(), ORG_A, { title: "Founder" })).resolves.toMatchObject({
      id: REP,
    });
  });

  it("refuses a SECOND root and says what to do instead", async () => {
    const { db } = fakeDb({ roots: [CEO] });
    const controller = new OrgChartPositionsController(db);
    await expect(controller.create(req(), ORG_A, { title: "Founder" })).rejects.toThrow(
      /already has a top position/,
    );
  });

  it("judges the root against the EFFECTIVE date, not today", async () => {
    // A root abolished on 30 June makes a create effective 1 July a legitimate
    // new root, so the check has to run against the tree as it will be then.
    const { db, issued } = fakeDb({ roots: [] });
    const controller = new OrgChartPositionsController(db);
    await controller.create(req(), ORG_A, { title: "Founder", effectiveFrom: "2026-07-01" });
    const rootCheck = issued.find((q) => q.text.includes("NOT EXISTS") && q.text.includes("FROM positions p"));
    expect(rootCheck?.values).toEqual(["2026-07-01"]);
  });
});

describe("§4.3 delete with reports", () => {
  it("refuses while reports remain, counting them", async () => {
    const { db } = fakeDb({ reports: [REP, SALES] });
    const controller = new OrgChartPositionsController(db);
    await expect(controller.remove(req(), ORG_A, CEO, {})).rejects.toThrow(
      /still has 2 position\(s\) reporting to it/,
    );
  });

  it("re-parents them onto the grandparent when promoteReports is asked for", async () => {
    const { db, issued } = fakeDb({ reports: [REP], managerOf: CEO });
    const controller = new OrgChartPositionsController(db);
    const result = await controller.remove(req(), ORG_A, SALES, { promoteReports: "1" });
    expect(result).toEqual({ ok: true, promoted: 1 });
    const inserted = issued.filter((q) => q.text.includes("INSERT INTO reporting_lines"));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].values).toContain(CEO);
  });

  it("refuses to promote the reports of the ROOT", async () => {
    // There is no grandparent, so every report would become a root - which
    // §4.3 forbids and `integrityProblems` would then report as broken data.
    const { db } = fakeDb({ reports: [SALES], managerOf: null });
    const controller = new OrgChartPositionsController(db);
    await expect(controller.remove(req(), ORG_A, CEO, { promoteReports: "1" })).rejects.toThrow(
      /top position/,
    );
  });

  it("deletes a leaf seat without argument", async () => {
    const { db, issued } = fakeDb({ reports: [] });
    const controller = new OrgChartPositionsController(db);
    await expect(controller.remove(req(), ORG_A, REP, {})).resolves.toEqual({
      ok: true,
      promoted: 0,
    });
    expect(issued.some((q) => q.text.includes("DELETE FROM positions"))).toBe(true);
  });
});

describe("§4.3 one primary holder, and history", () => {
  it("ends the outgoing assignment before inserting the incoming one", async () => {
    const { db, issued } = fakeDb({ openPrimary: { id: "old", user_id: "someone-else" } });
    const controller = new OrgChartPositionsController(db);
    const result = await controller.assign(req(), ORG_A, SALES, { userId: USER_A });
    expect(result.replacedAssignmentId).toBe("old");

    const end = issued.findIndex((q) => q.text.includes("UPDATE position_assignments"));
    const insert = issued.findIndex((q) => q.text.includes("INSERT INTO position_assignments"));
    expect(end).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(end);
  });

  it("NEVER updates user_id in place", async () => {
    // An updated row would claim the new person held the seat for the departed
    // person's whole tenure.
    const { db, issued } = fakeDb({ openPrimary: { id: "old", user_id: "someone-else" } });
    const controller = new OrgChartPositionsController(db);
    await controller.assign(req(), ORG_A, SALES, { userId: USER_A });
    for (const q of issued) expect(q.text).not.toMatch(/SET\s+user_id/);
  });

  it("does not end the primary when the new holder is ACTING", async () => {
    // §4.1: an acting cover is additional and must overlap the primary.
    const { db, issued } = fakeDb({ openPrimary: { id: "old", user_id: "someone-else" } });
    const controller = new OrgChartPositionsController(db);
    await controller.assign(req(), ORG_A, SALES, { userId: USER_A, assignmentType: "acting" });
    expect(issued.some((q) => q.text.includes("UPDATE position_assignments"))).toBe(false);
  });

  it("refuses to fill a FROZEN seat", async () => {
    // §10 lists "active assignment on a frozen position" as a fault to alert
    // on; the cheapest place to prevent it is the route that would create it.
    const { db } = fakeDb({ frozen: true });
    const controller = new OrgChartPositionsController(db);
    await expect(controller.assign(req(), ORG_A, SALES, { userId: USER_A })).rejects.toThrow(
      /frozen/,
    );
  });

  it("refuses somebody who is not a member of the workspace", async () => {
    // `position_assignments.user_id` references `users`, a PLATFORM table with
    // no RLS - so the FK alone is satisfied by another tenant's user id.
    const { db } = fakeDb({ member: false });
    const controller = new OrgChartPositionsController(db);
    await expect(controller.assign(req(), ORG_A, SALES, { userId: USER_A })).rejects.toThrow(
      /not a member of this workspace/,
    );
  });

  it("prefills the position's default KPI targets without overwriting existing ones", async () => {
    const { db, issued } = fakeDb({});
    const controller = new OrgChartPositionsController(db);
    await controller.assign(req(), ORG_A, SALES, { userId: USER_A });
    const seed = issued.find((q) => q.text.includes("INSERT INTO sales_targets"));
    expect(seed).toBeTruthy();
    // A target somebody already has for the period is left alone - it is what
    // their incentive is computed against.
    expect(seed?.text).toMatch(/NOT EXISTS/);
  });

  it("tells the new holder, and never the person who did it", async () => {
    const { db, issued } = fakeDb({});
    const controller = new OrgChartPositionsController(db);
    await controller.assign(req({ principal: sessionPrincipal({ userId: USER_A }) }), ORG_A, SALES, {
      userId: USER_A,
    });
    // `notify` returns early for a self-action, so no row is written.
    expect(issued.some((q) => q.text.includes("INSERT INTO notifications"))).toBe(false);
  });

  it("refuses to unassign a seat nobody holds", async () => {
    const { db } = fakeDb({ openPrimary: null });
    const controller = new OrgChartPositionsController(db);
    await expect(controller.unassign(req(), ORG_A, SALES, {})).rejects.toThrow(NotFoundException);
  });
});

describe("the authority table (§6.2)", () => {
  it("refuses a position as its own approver", async () => {
    // "Approve a refund over ₹10,000 with the approval of ... yourself" is a
    // limit that reads as a control and is none.
    const { db } = fakeDb({});
    const controller = new OrgChartPositionsController(db);
    await expect(
      controller.setAuthority(req(), ORG_A, SALES, {
        items: [{ action: "approve_refund", limitNum: 10_000, currency: "INR", requiresApprovalFromPositionId: SALES }],
      }),
    ).rejects.toThrow(/its own approver/);
  });

  it("accepts a blank approver, which escalates up the reporting line", async () => {
    const { db } = fakeDb({});
    const controller = new OrgChartPositionsController(db);
    await expect(
      controller.setAuthority(req(), ORG_A, SALES, {
        items: [{ action: "approve_refund", limitNum: 10_000, currency: "INR" }],
      }),
    ).resolves.toEqual({ ok: true, count: 1 });
  });

  it("replaces the whole table rather than merging", async () => {
    const { db, issued } = fakeDb({});
    const controller = new OrgChartPositionsController(db);
    await controller.setAuthority(req(), ORG_A, SALES, { items: [] });
    expect(issued.some((q) => q.text.includes("DELETE FROM position_authorities"))).toBe(true);
  });
});

describe("§14's manager-edit setting", () => {
  it("refuses when the org has not turned it on, and says who can", async () => {
    const { db } = fakeDb({ settings: null });
    const controller = new OrgChartPositionsController(db);
    await expect(
      controller.setResponsibilitiesAsManager(req(), ORG_A, REP, { items: [] }),
    ).rejects.toThrow(/An owner can turn that on/);
  });

  it("refuses a seat that is not the caller's own direct report", async () => {
    const { db, client } = fakeDb({ settings: { manager_edits_reports: true } });
    // No seat held by the caller.
    (client.query as jest.Mock).mockImplementation(async (text: string) => {
      if (text.includes("CURRENT_DATE::text")) return { rows: [{ today: TODAY }] };
      if (text.includes("FROM org_chart_settings")) {
        return { rows: [{ manager_edits_reports: true }] };
      }
      if (text.includes("FROM position_assignments")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    const controller = new OrgChartPositionsController(db);
    await expect(
      controller.setResponsibilitiesAsManager(req(), ORG_A, REP, { items: [] }),
    ).rejects.toThrow(/own direct reports|turn that on/);
  });
});

describe("§7's contract protections", () => {
  const contractRow = {
    id: CONTRACT,
    user_id: USER_A,
    user_name: "Priya",
    user_email: "priya@example.com",
    position_id: SALES,
    position_title: "Head of Sales",
    employment_type: "full_time",
    start_date: "2024-01-01",
    end_date: "2026-11-30",
    renewal_date: null,
    probation_end_date: null,
    notice_period_days: 30,
    comp_structure: "fixed_plus_incentive",
    comp_fixed_num: "90000",
    comp_currency: "INR",
    status: "active" as const,
    notes: "Reviewed in April.",
  };

  it("mints a SHORT-LIVED signed URL and logs the access", async () => {
    const { db, issued } = fakeDb({
      document: {
        id: DOCUMENT,
        contract_id: CONTRACT,
        s3_key: "org-charts/o/contracts/c/abc",
        content_type: "application/pdf",
        file_name: "offer.pdf",
        user_id: USER_A,
      },
    });
    const controller = new OrgChartContractsController(db, s3);
    const result = await controller.documentUrl(req(), ORG_A, DOCUMENT, UNSCOPED);

    expect(result.expiresInSeconds).toBe(300);
    expect(s3.presignedGetUrl).toHaveBeenCalledWith(
      "org-charts/o/contracts/c/abc",
      300,
      "application/pdf",
    );
    const log = issued.find((q) => q.text.includes("INSERT INTO document_access_log"));
    // `action` is a literal in the statement rather than a bound parameter -
    // there is exactly one value it can take per call site, and binding it
    // would let a caller choose how their own access is recorded.
    expect(log?.text).toMatch(/'url'/);
    expect(log?.values).toContain("203.0.113.7");
  });

  it("answers 404 - not 403 - when a scoped reader asks for somebody else's document", async () => {
    // A 403 would confirm the id EXISTS, which for a table of one row per
    // employee is the difference between guessing an id and learning that a
    // colleague has a contract on file.
    const { db } = fakeDb({
      document: {
        id: DOCUMENT,
        contract_id: CONTRACT,
        s3_key: "k",
        content_type: "application/pdf",
        file_name: "f.pdf",
        user_id: "somebody-else",
      },
    });
    const controller = new OrgChartContractsController(db, s3);
    await expect(
      controller.documentUrl(req(), ORG_A, DOCUMENT, { scope: "owned", userId: USER_A }),
    ).rejects.toThrow(NotFoundException);
  });

  it("narrows the LIST by the owner column for a scoped reader", async () => {
    const { db, issued } = fakeDb({ contract: contractRow });
    const controller = new OrgChartContractsController(db, s3);
    await controller.list(ORG_A, {}, { scope: "owned", userId: USER_A });
    const read = issued.find((q) => q.text.includes("FROM employment_contracts c"));
    expect(read?.text).toMatch(/c\.user_id = \$\d+/);
    expect(read?.values).toContain(USER_A);
  });

  it("refuses a content type the bucket could serve as a script", async () => {
    // `content_type` is echoed back as a signed GET's ResponseContentType, so
    // `text/html` would make object storage serve a script from a URL the
    // console hands out.
    const { db } = fakeDb({ contract: contractRow });
    const controller = new OrgChartContractsController(db, s3);
    await expect(
      controller.addDocument(req(), ORG_A, CONTRACT, {
        docType: "contract",
        fileName: "x.html",
        contentType: "text/html",
        bytes: 10,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("keeps the compensation figure OUT of the change log", async () => {
    /**
     * `org_change_log` is read by §6.5's History tab, which is gated on
     * `position:view` - every persona. A salary in `after` would publish every
     * pay packet to the whole floor through a screen nobody thinks of as a
     * contract page.
     */
    const { db, issued } = fakeDb({});
    const controller = new OrgChartContractsController(db, s3);
    await controller.create(req(), ORG_A, {
      userId: USER_A,
      employmentType: "full_time",
      startDate: "2026-01-01",
      compFixedNum: 90_000,
      compCurrency: "INR",
      compStructure: "fixed",
    });
    const log = issued.find((q) => q.text.includes("INSERT INTO org_change_log"));
    expect(JSON.stringify(log?.values)).not.toMatch(/90000/);
  });

  it("names the storage key by a random id, never by the file name", async () => {
    // A signed URL is a credential and travels through browser history and
    // server logs; a key containing `priya-offer-letter.pdf` leaks who it is
    // about to anybody who sees one.
    const { db, issued } = fakeDb({ contract: contractRow });
    const controller = new OrgChartContractsController(db, s3);
    await controller.addDocument(req(), ORG_A, CONTRACT, {
      docType: "offer_letter",
      fileName: "priya-offer-letter.pdf",
      contentType: "application/pdf",
      bytes: 1024,
    });
    const insert = issued.find((q) => q.text.includes("INSERT INTO contract_documents"));
    const key = insert?.values.find((v) => typeof v === "string" && v.startsWith("org-charts/"));
    expect(key).toBeTruthy();
    expect(key).not.toMatch(/priya/);
  });

  it("computes the next version in the INSERT rather than reading it first", async () => {
    // Two uploads racing would both read `max = 2` and both write 3.
    const { db, issued } = fakeDb({ contract: contractRow });
    const controller = new OrgChartContractsController(db, s3);
    await controller.addDocument(req(), ORG_A, CONTRACT, {
      docType: "contract",
      fileName: "c.pdf",
      contentType: "application/pdf",
      bytes: 10,
    });
    const insert = issued.find((q) => q.text.includes("INSERT INTO contract_documents"));
    expect(insert?.text).toMatch(/COALESCE\(max\(d\.version\), 0\) \+ 1/);
  });

  it("refuses a probation date before the contract starts", async () => {
    const { db } = fakeDb({});
    const controller = new OrgChartContractsController(db, s3);
    await expect(
      controller.create(req(), ORG_A, {
        userId: USER_A,
        employmentType: "probation",
        startDate: "2026-06-01",
        probationEndDate: "2026-05-01",
      }),
    ).rejects.toThrow(/Probation cannot end before/);
  });

  it("logs a document LIST, not only a download", async () => {
    // An access log that only records downloads cannot answer "who has been
    // looking at Priya's file".
    const { db, client, issued } = fakeDb({ contract: contractRow });
    (client.query as jest.Mock).mockImplementation(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (text.includes("CURRENT_DATE::text")) return { rows: [{ today: TODAY }], rowCount: 1 };
      if (text.includes("FROM employment_contracts c")) return { rows: [contractRow], rowCount: 1 };
      if (text.includes("FROM contract_documents d")) {
        return { rows: [{ id: DOCUMENT, doc_type: "contract", file_name: "c.pdf", content_type: "application/pdf", bytes: "10", version: 1, signed_at: null, created_at: "2026-01-01", uploaded_by_name: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const controller = new OrgChartContractsController(db, s3);
    await controller.one(req(), ORG_A, CONTRACT, UNSCOPED);
    const log = issued.find((q) => q.text.includes("INSERT INTO document_access_log"));
    expect(log?.text).toMatch(/'list'/);
  });
});

describe("the chart read (§12)", () => {
  it("never uses the RLS-bypassing admin pool", () => {
    // Everything here is tenant data. A read that reached for the admin pool
    // would be a cross-tenant read with no policy in front of it.
    const source = [
      readFileSync(join(__dirname, "org-chart.controller.ts"), "utf8"),
      readFileSync(join(__dirname, "org-chart-positions.controller.ts"), "utf8"),
      readFileSync(join(__dirname, "org-chart-contracts.controller.ts"), "utf8"),
      readFileSync(join(__dirname, "tree.ts"), "utf8"),
    ].join("\n");
    expect(source).not.toMatch(/adminPool|getAdminPool/);
  });

  it("asks the DATABASE for today rather than the container's clock", () => {
    // `withOrgContext` sets TimeZone per org, so `CURRENT_DATE` is the
    // tenant's own date. `new Date()` in a UTC container is yesterday for an
    // Asia/Kolkata tenant for five and a half hours every night.
    const tree = readFileSync(join(__dirname, "tree.ts"), "utf8");
    expect(tree).toMatch(/SELECT CURRENT_DATE::text AS today/);
    for (const file of ["org-chart.controller.ts", "org-chart-positions.controller.ts"]) {
      const source = readFileSync(join(__dirname, file), "utf8");
      expect(source).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice/);
    }
  });
});
