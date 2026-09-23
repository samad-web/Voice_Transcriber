/**
 * `POST /connections/oauth/abandon` - the Google/Microsoft callback page's way
 * back to where a sign-in began when the provider returned no code (doc 28
 * §11.3, §11.6).
 *
 * No database: `DbService` is a fake that records every statement.
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ORG_A, USER_A, adminKeyPrincipal } from "../../common/guard-harness.spec";
import type { DbService } from "../../db/db.service";
import { ConnectionsController } from "./connections.controller";

interface Issued {
  text: string;
  values: unknown[];
}

function fakeDb(rows: unknown[]) {
  const issued: Issued[] = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      return { rows, rowCount: rows.length };
    }),
  };
  const db = {
    withOrg: async (_orgId: string, fn: (c: typeof client) => Promise<unknown>) => fn(client),
  } as unknown as DbService;
  return { db, issued };
}

function reqFor(userId: string = USER_A) {
  return { principal: adminKeyPrincipal({ orgId: ORG_A, userId }), headers: {} } as never;
}

describe("POST /connections/oauth/abandon", () => {
  it("returns where the sign-in began, and consumes the state bound to the caller", async () => {
    const { db, issued } = fakeDb([{ redirect_path: "/owner/integrations/google_workspace" }]);

    await expect(
      new ConnectionsController(db).abandon(ORG_A, { state: "the-state" }, reqFor()),
    ).resolves.toEqual({ redirectPath: "/owner/integrations/google_workspace" });

    expect(issued).toHaveLength(1);
    expect(issued[0].text).toMatch(/DELETE FROM oauth_authorizations/);
    expect(issued[0].text).toMatch(/user_id = \$2/);
    expect(issued[0].values).toEqual(["the-state", USER_A]);
  });

  it("falls back to the store for an unknown, used or somebody else's state", async () => {
    await expect(
      new ConnectionsController(fakeDb([]).db).abandon(ORG_A, { state: "gone" }, reqFor()),
    ).resolves.toEqual({ redirectPath: "/owner/integrations" });
  });

  it("never returns a stored path that leaves the console", async () => {
    const { db } = fakeDb([{ redirect_path: "//evil.example.com" }]);
    await expect(new ConnectionsController(db).abandon(ORG_A, { state: "s" }, reqFor())).resolves.toEqual({
      redirectPath: "/owner/integrations",
    });
  });

  it("400s a missing state and 403s a caller with no person behind it", async () => {
    const controller = new ConnectionsController(fakeDb([]).db);
    await expect(controller.abandon(ORG_A, {}, reqFor())).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.abandon(ORG_A, { state: "s" }, reqFor("admin-key"))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
