import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resumePoint, type FetchLimits } from "./email-providers";
import { syncConnection } from "./email-sync";

/**
 * Paging, caps, and the console's Outlook sends.
 *
 * Everything here drives the real `syncConnection` against a fake provider
 * and a fake database, because the bug these cover lived in the seam between
 * the two: the adapters read one page of 50, and the sync then moved the
 * connection's position to "now", so message 51 onwards in any window was
 * never looked at again. Nothing errored; the mail was simply never there.
 */

const SELF = "rep@example.com";
const CONTACT = "priya@customer.com";
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const STRANGER = "doctor@clinic.example";

interface FakeMail {
  id: string;
  internetMessageId: string;
  from: string;
  to: string[];
  subject: string;
  at: Date;
  isDraft?: boolean;
}

interface StoredInteraction {
  external_id: string | null;
  connection_id: string;
  direction: string;
  subject: string | null;
  metadata: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Deterministically scrambled, so a Gmail test cannot pass by leaning on the
 * list coming back newest-first - Gmail does not document its order.
 */
function scramble<T>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, key: (i * 7919) % 104_729 }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

/** Gmail's list + get, honouring `after:`/`before:`, maxResults and page tokens. */
function fakeGmail(mailbox: FakeMail[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/messages")) {
      const q = url.searchParams.get("q") ?? "";
      const after = Number(/after:(-?\d+)/.exec(q)?.[1] ?? "0");
      const before = /before:(\d+)/.exec(q);
      const max = Number(url.searchParams.get("maxResults") ?? "100");
      const offset = Number(url.searchParams.get("pageToken") ?? "0");
      const hits = scramble(
        mailbox.filter(
          (m) =>
            !m.isDraft &&
            m.at.getTime() / 1000 > after &&
            (!before || m.at.getTime() / 1000 < Number(before[1])),
        ),
      );
      const page = hits.slice(offset, offset + max);
      return json({
        messages: page.map((m) => ({ id: m.id })),
        ...(offset + max < hits.length ? { nextPageToken: String(offset + max) } : {}),
      });
    }
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const m = mailbox.find((x) => x.id === id);
    if (!m) return json({ error: "not found" }, 404);
    return json({
      id: m.id,
      internalDate: String(m.at.getTime()),
      snippet: `snippet of ${m.subject}`,
      payload: {
        headers: [
          { name: "From", value: m.from },
          { name: "To", value: m.to.join(", ") },
          { name: "Subject", value: m.subject },
        ],
      },
    });
  }) as typeof fetch;
}

/**
 * Graph's /me/messages: `ge` filter, $orderby, $top, and a $skip nextLink.
 * Honours the requested order, so an adapter that forgot to ask for oldest
 * first gets Graph's real default - newest first - and the tests notice.
 */
function fakeGraph(mailbox: FakeMail[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const filter = url.searchParams.get("$filter") ?? "";
    const ge = new Date(/receivedDateTime ge (\S+)/.exec(filter)?.[1] ?? 0);
    const ascending = url.searchParams.get("$orderby") === "receivedDateTime asc";
    const top = Number(url.searchParams.get("$top") ?? "10");
    const skip = Number(url.searchParams.get("$skip") ?? "0");
    const hits = mailbox
      .filter((m) => m.at.getTime() >= ge.getTime())
      .sort((a, b) => (ascending ? 1 : -1) * (a.at.getTime() - b.at.getTime()));
    const page = hits.slice(skip, skip + top);
    const next = new URL(url);
    next.searchParams.set("$skip", String(skip + top));
    return json({
      value: page.map((m) => ({
        id: m.id,
        subject: m.subject,
        bodyPreview: `snippet of ${m.subject}`,
        // Graph's times are whole seconds.
        receivedDateTime: m.at.toISOString().replace(/\.\d{3}Z$/, "Z"),
        internetMessageId: m.internetMessageId,
        isDraft: m.isDraft ?? false,
        from: { emailAddress: { address: m.from } },
        toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
      })),
      ...(skip + top < hits.length ? { "@odata.nextLink": next.toString() } : {}),
    });
  }) as typeof fetch;
}

/** Just enough of Postgres for syncConnection: contacts, the insert, the cursor. */
function fakeDb(seed: StoredInteraction[] = []) {
  const contacts = new Map([[CONTACT, CONTACT_ID]]);
  const interactions: StoredInteraction[] = [...seed];
  const account = {
    sync_cursor: null as string | null,
    last_synced_at: new Date(Date.now() - 2 * 3_600_000) as Date | null,
  };
  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (/FROM contacts/.test(sql)) {
        const wanted = params[0] as string[];
        const rows = [...contacts]
          .filter(([email]) => wanted.includes(email))
          .map(([email, id]) => ({ id, email }));
        return { rows, rowCount: rows.length };
      }
      if (/FROM deals/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM interactions/.test(sql) && /internet_message_id/.test(sql)) {
        const rows = interactions.filter(
          (i) => i.connection_id === params[0] && i.metadata.internet_message_id === params[1],
        );
        return { rows, rowCount: rows.length };
      }
      if (/INSERT INTO interactions/.test(sql)) {
        const externalId = params[5] as string;
        if (interactions.some((i) => i.external_id === externalId)) {
          return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
        }
        interactions.push({
          external_id: externalId,
          connection_id: params[4] as string,
          direction: params[1] as string,
          subject: params[6] as string | null,
          metadata: JSON.parse(params[10] as string) as Record<string, unknown>,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE connected_accounts/.test(sql)) {
        account.sync_cursor = params[1] as string | null;
        // The pre-fix code wrote now() in SQL and passed no third parameter.
        account.last_synced_at = (params[2] as Date | undefined) ?? new Date();
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fake db: unexpected query ${sql}`);
    },
  };
  return { client, interactions, account };
}

function connectionRow(
  provider: string,
  account: { sync_cursor: string | null; last_synced_at: Date | null },
) {
  return {
    id: CONNECTION_ID,
    org_id: ORG_ID,
    user_id: USER_ID,
    provider,
    account_email: SELF,
    access_token: "token", // plaintext passes straight through decryptSecret
    refresh_token: null,
    token_expires_at: null,
    sync_cursor: account.sync_cursor,
    last_synced_at: account.last_synced_at,
    sync_failures: 0,
    oauth_client_id: null,
  };
}

type Db = ReturnType<typeof fakeDb>;

async function pass(provider: string, fetchImpl: typeof fetch, db: Db, limits?: FetchLimits) {
  return syncConnection(
    db.client as unknown as Parameters<typeof syncConnection>[0],
    connectionRow(provider, db.account),
    fetchImpl,
    limits,
  );
}

/**
 * 120 messages with a contact across one hour, alternating direction, 30s
 * apart - plus a stranger's message every tenth slot, which must never land.
 */
function busyHour(): { mailbox: FakeMail[]; contactIds: Set<string> } {
  const start = Math.floor(Date.now() / 1000) * 1000 - 65 * 60_000;
  const mailbox: FakeMail[] = [];
  const contactIds = new Set<string>();
  for (let i = 0; i < 120; i++) {
    const outgoing = i % 2 === 1;
    const id = `msg-${String(i).padStart(3, "0")}`;
    contactIds.add(id);
    mailbox.push({
      id,
      internetMessageId: `<${id}@mail.example>`,
      from: outgoing ? SELF : CONTACT,
      to: [outgoing ? CONTACT : SELF],
      subject: `Thread ${i}`,
      at: new Date(start + i * 30_000),
    });
    if (i % 10 === 0) {
      mailbox.push({
        id: `private-${i}`,
        internetMessageId: `<private-${i}@clinic.example>`,
        from: STRANGER,
        to: [SELF],
        subject: "Your appointment",
        at: new Date(start + i * 30_000 + 15_000),
      });
    }
  }
  return { mailbox, contactIds };
}

/**
 * Run passes until the connection has caught up, checking after EVERY pass
 * the invariant the bug broke: the next window (position minus the overlap)
 * must still reach every contact message not yet written.
 */
async function syncUntilCaughtUp(
  provider: string,
  mailbox: FakeMail[],
  db: Db,
  limits?: FetchLimits,
): Promise<number> {
  const fetchImpl = provider === "google" ? fakeGmail(mailbox) : fakeGraph(mailbox);
  for (let n = 1; n <= 80; n++) {
    await pass(provider, fetchImpl, db, limits);

    const nextSince =
      resumePoint(db.account.sync_cursor) ??
      new Date((db.account.last_synced_at as Date).getTime() - 10 * 60_000);
    const stored = new Set(db.interactions.map((i) => i.external_id));
    const unreachable = mailbox
      .filter((m) => m.from !== STRANGER && !stored.has(m.id))
      .filter((m) => m.at.getTime() < nextSince.getTime())
      .map((m) => m.id);
    expect(unreachable).toEqual([]);

    if (resumePoint(db.account.sync_cursor) === null) return n;
  }
  throw new Error("never caught up");
}

describe.each(["google", "microsoft"])("syncConnection over a busy window (%s)", (provider) => {
  const saved = process.env.EMAIL_STUB;
  beforeEach(() => {
    delete process.env.EMAIL_STUB;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EMAIL_STUB;
    else process.env.EMAIL_STUB = saved;
  });

  it("lands all 120 messages in one window, not just the first page of 50", async () => {
    const { mailbox, contactIds } = busyHour();
    const db = fakeDb();

    await syncUntilCaughtUp(provider, mailbox, db);

    const stored = db.interactions.map((i) => i.external_id);
    expect(stored).toHaveLength(120);
    expect(new Set(stored)).toEqual(contactIds);
    // The safety rule holds on the way through: the stranger's mail was read
    // from the provider and dropped, never written.
    expect(stored.filter((id) => id?.startsWith("private-"))).toEqual([]);
  });

  it("loses nothing when the per-pass cap is hit - the backlog drains over several passes", async () => {
    const { mailbox, contactIds } = busyHour();
    const db = fakeDb();

    // 20 messages a pass against 132 in the window.
    const passes = await syncUntilCaughtUp(provider, mailbox, db, { pageSize: 10, maxPages: 2 });

    expect(passes).toBeGreaterThan(1);
    expect(db.interactions).toHaveLength(120);
    expect(new Set(db.interactions.map((i) => i.external_id))).toEqual(contactIds);
  });

  it("stops short of now after a capped pass, and says where to resume", async () => {
    const { mailbox } = busyHour();
    const db = fakeDb();
    const fetchImpl = provider === "google" ? fakeGmail(mailbox) : fakeGraph(mailbox);

    await pass(provider, fetchImpl, db, { pageSize: 10, maxPages: 2 });

    expect(db.interactions.length).toBeLessThan(120);
    expect(resumePoint(db.account.sync_cursor)).not.toBeNull();
    // Well short of the present - the old code wrote now() here.
    expect((db.account.last_synced_at as Date).getTime()).toBeLessThan(Date.now() - 5 * 60_000);
  });

  it("clears the resume point once caught up, so the ordinary overlap takes over", async () => {
    const { mailbox } = busyHour();
    const db = fakeDb();
    await syncUntilCaughtUp(provider, mailbox, db, { pageSize: 10, maxPages: 2 });
    expect(db.account.sync_cursor).toBeNull();
    expect((db.account.last_synced_at as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("syncConnection - an Outlook send from the console, then a sync", () => {
  const saved = process.env.EMAIL_STUB;
  beforeEach(() => {
    delete process.env.EMAIL_STUB;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EMAIL_STUB;
    else process.env.EMAIL_STUB = saved;
  });

  const MESSAGE_ID = "<console-send-1@SN6PR.prod.outlook.com>";
  const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000);

  /** The row outbound-mail.controller.ts writes after a Graph send. */
  const consoleRow = (): StoredInteraction => ({
    external_id: null, // Graph gave no id the sync could ever match
    connection_id: CONNECTION_ID,
    direction: "outgoing",
    subject: "Your quote",
    metadata: { from: SELF, to: [CONTACT], sent: true, internet_message_id: MESSAGE_ID },
  });

  /** What Graph lists afterwards: the Sent Items copy, under a NEW id. */
  const sentCopy: FakeMail = {
    id: "AAMkSentItems-copy",
    internetMessageId: MESSAGE_ID,
    from: SELF,
    to: [CONTACT],
    subject: "Your quote",
    at: sentAt,
  };

  it("yields ONE timeline row, not the console's plus the Sent copy", async () => {
    const row = consoleRow();
    const db = fakeDb([row]);

    await pass("microsoft", fakeGraph([sentCopy]), db);

    expect(db.interactions).toHaveLength(1);
    expect(db.interactions[0]).toBe(row);
  });

  it("stays at one row across repeated passes over the overlap window", async () => {
    const db = fakeDb([consoleRow()]);
    for (let n = 0; n < 3; n++) await pass("microsoft", fakeGraph([sentCopy]), db);
    expect(db.interactions).toHaveLength(1);
  });

  it("ignores the draft the send passes through on its way out", async () => {
    const db = fakeDb();
    await pass("microsoft", fakeGraph([{ ...sentCopy, id: "AAMkDraft", isDraft: true }]), db);
    expect(db.interactions).toHaveLength(0);
  });

  it("records the Message-ID on a synced row, so the console can see the sync got there first", async () => {
    const db = fakeDb();
    await pass("microsoft", fakeGraph([sentCopy]), db);
    expect(db.interactions).toHaveLength(1);
    expect(db.interactions[0].metadata.internet_message_id).toBe(MESSAGE_ID);
  });

  it("still keeps a different message to the same contact", async () => {
    const db = fakeDb([consoleRow()]);
    const reply: FakeMail = {
      ...sentCopy,
      id: "AAMkReply",
      internetMessageId: "<reply@customer.com>",
      from: CONTACT,
      to: [SELF],
      at: new Date(sentAt.getTime() + 60_000),
    };
    await pass("microsoft", fakeGraph([sentCopy, reply]), db);
    expect(db.interactions.map((i) => i.external_id)).toEqual([null, "AAMkReply"]);
  });

  it("does not collapse the same Message-ID across two colleagues' mailboxes", async () => {
    // One customer email to two reps: each connection keeps its own row, as
    // before this fix. The Message-ID check is per connection on purpose.
    const colleagueRow = { ...consoleRow(), connection_id: "55555555-5555-4555-8555-555555555555" };
    const db = fakeDb([colleagueRow]);
    await pass("microsoft", fakeGraph([sentCopy]), db);
    expect(db.interactions).toHaveLength(2);
  });
});
