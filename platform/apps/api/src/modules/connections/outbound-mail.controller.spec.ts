import { UNSCOPED } from "../../common/crm-scope";
import type { PrincipalRequest } from "../../common/auth-principal";
import type { DbService } from "../../db/db.service";
import { OutboundMailController } from "./outbound-mail.controller";

/**
 * The console's half of the Outlook de-duplication.
 *
 * The worker's mail sync skips a Sent Items copy whose Message-ID is already
 * on a row from the same mailbox (apps/worker email-providers.test.ts covers
 * that side). These cases pin the other half: that the console's row carries
 * the key under the name the sync looks for, and that when the sync got there
 * first the console does not add a second row - while still auditing the
 * send, which happened either way.
 */

const ORG = "33333333-3333-4333-8333-333333333333";
const CONTACT = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const USER = "44444444-4444-4444-8444-444444444444";
const MESSAGE_ID = "<draft-1@prod.outlook.com>";

function fakeDb(options: { alreadySynced: boolean }) {
  const inserts: unknown[][] = [];
  const audits: unknown[][] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (/FROM contacts/.test(sql)) {
        return {
          rows: [{ id: CONTACT, email: "priya@customer.com", display_name: "Priya" }],
          rowCount: 1,
        };
      }
      if (/FROM connected_accounts/.test(sql)) {
        return {
          rows: [
            {
              id: CONNECTION,
              provider: "microsoft",
              account_email: "rep@example.com",
              display_name: null,
              access_token: "token",
              refresh_token: null,
              token_expires_at: null,
              config: null,
              secret: null,
              oauth_client_id: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: "0" }], rowCount: 1 };
      if (/FROM deals/.test(sql)) return { rows: [], rowCount: 0 };
      if (/internet_message_id/.test(sql) && /SELECT 1/.test(sql)) {
        expect(params).toEqual([CONNECTION, MESSAGE_ID]);
        return options.alreadySynced ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO interactions/.test(sql)) {
        inserts.push(params);
        return { rows: [{ id: "new-row" }], rowCount: 1 };
      }
      if (/UPDATE contacts/.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO audit_log/.test(sql)) {
        audits.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fake db: unexpected query ${sql}`);
    },
  };
  const db = {
    withOrg: (_org: string, fn: (c: typeof client) => unknown) => fn(client),
  } as unknown as DbService;
  return { db, inserts, audits };
}

describe("OutboundMailController - Outlook sends and the mail sync", () => {
  const savedEnv = process.env.EMAIL_SENDING_ENABLED;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.EMAIL_SENDING_ENABLED = "true";
    fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "AAMkDraft", internetMessageId: MESSAGE_ID }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (savedEnv === undefined) delete process.env.EMAIL_SENDING_ENABLED;
    else process.env.EMAIL_SENDING_ENABLED = savedEnv;
  });

  const req = { principal: { userId: USER } } as unknown as PrincipalRequest;
  const body = { subject: "Your quote", body: "Attached." };

  it("records the Message-ID as metadata.internet_message_id - the key the sync checks", async () => {
    const { db, inserts } = fakeDb({ alreadySynced: false });
    const out = await new OutboundMailController(db).sendToContact(ORG, CONTACT, body, req, UNSCOPED);

    expect(out).toMatchObject({ sent: true, interaction: { id: "new-row" } });
    expect(inserts).toHaveLength(1);
    const [, , , connectionId, externalId, , , , metadata] = inserts[0];
    expect(connectionId).toBe(CONNECTION);
    expect(externalId).toBeNull();
    expect(JSON.parse(metadata as string)).toMatchObject({
      sent: true,
      internet_message_id: MESSAGE_ID,
    });
  });

  it("writes no second row when the sync already recorded the Sent copy - but still audits", async () => {
    const { db, inserts, audits } = fakeDb({ alreadySynced: true });
    const out = await new OutboundMailController(db).sendToContact(ORG, CONTACT, body, req, UNSCOPED);

    expect(out).toMatchObject({ sent: true, interaction: null });
    expect(inserts).toHaveLength(0);
    expect(audits).toHaveLength(1);
  });
});
