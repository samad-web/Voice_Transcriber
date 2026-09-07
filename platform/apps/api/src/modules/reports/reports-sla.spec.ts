import { ForbiddenException } from "@nestjs/common";
import { ReportsService } from "./reports.service";
import type { CrmRecordScope } from "../../common/crm-scope";

/**
 * The scope contract for the three Tier-1 reports (migration 0090).
 *
 * Two of them read `leads`, which has no owner_user_id: a lead is assigned to
 * a `telecallers` row, and a telecaller is not a console user. So an
 * `owned`-scoped caller cannot be served an honest answer, and the rule the
 * platform already follows - refuse, never silently widen - has to hold here
 * too. This file is what guard-mounting.spec.ts points at when it says so.
 *
 * The database is a landmine on purpose: reaching it means the refusal did not
 * happen first, which is exactly the failure being guarded against. A report
 * that queries and THEN refuses would still have read rows it was not allowed
 * to read.
 */

const REACHED_THE_DATABASE = "reports-sla.spec: query ran when it should not have";

const landmineDb = {
  withOrg: () => {
    throw new Error(REACHED_THE_DATABASE);
  },
} as unknown as ConstructorParameters<typeof ReportsService>[0];

const owned: CrmRecordScope = { scope: "owned", userId: "11111111-1111-1111-1111-111111111111" };
const all: CrmRecordScope = { scope: "all", userId: null };

describe("owned scope on the lead-backed reports", () => {
  const reports = new ReportsService(landmineDb);

  it("refuses response time before touching the database", async () => {
    await expect(reports.responseTime("org", "2026-01-01", "2026-01-31", owned)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("refuses lead aging before touching the database", async () => {
    await expect(reports.leadAging("org", owned)).rejects.toThrow(ForbiddenException);
  });

  it("explains what to do instead, rather than just saying no", async () => {
    // A bare 403 on a report a rep can see in the nav reads as a bug. The
    // message has to say why it cannot be scoped and who can change it.
    await expect(reports.leadAging("org", owned)).rejects.toThrow(/telecaller/i);
  });

  it("does not refuse an unscoped caller", async () => {
    // Reaching the landmine is the pass condition: it proves the guard let
    // this one through rather than refusing everybody.
    await expect(reports.leadAging("org", all)).rejects.toThrow(REACHED_THE_DATABASE);
  });
});

describe("owned scope on follow-up compliance", () => {
  const reports = new ReportsService(landmineDb);

  it("is allowed, because a task CAN express `owned`", async () => {
    // tasks carry assignee_user_id and created_by, so crm-scope.ts has a real
    // predicate for this one. It must not inherit the leads refusal.
    await expect(
      reports.followupCompliance("org", "2026-01-01", "2026-01-31", owned),
    ).rejects.toThrow(REACHED_THE_DATABASE);
  });
});
