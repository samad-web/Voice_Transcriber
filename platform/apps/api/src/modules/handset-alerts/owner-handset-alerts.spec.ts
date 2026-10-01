import { groupSent } from "./owner-handset-alerts.controller";

const NOW = Date.parse("2026-10-01T10:00:00Z");
const row = (over: Partial<Parameters<typeof groupSent>[0][number]>) => ({
  batch_id: "b1",
  title: "Message from Asha",
  body: "Team meeting at 4",
  style: "popup",
  created_at: new Date("2026-10-01T09:00:00Z"),
  expires_at: new Date("2026-10-02T09:00:00Z"),
  delivered_at: null,
  opened_at: null,
  telecaller_id: "t1",
  telecaller_name: "Brindha",
  sent_by: "Asha",
  has_phone: true,
  ...over,
});

describe("groupSent", () => {
  it("folds one row per recipient into one send, keeping the order it was given", () => {
    const sent = groupSent(
      [
        row({ batch_id: "b2", created_at: new Date("2026-10-01T09:30:00Z"), style: "notify" }),
        row({ telecaller_id: "t1", opened_at: new Date("2026-10-01T09:05:00Z"), delivered_at: new Date("2026-10-01T09:01:00Z") }),
        row({ telecaller_id: "t2", telecaller_name: "Kavya", delivered_at: new Date("2026-10-01T09:02:00Z") }),
        row({ telecaller_id: "t3", telecaller_name: "Ravi" }),
        row({ telecaller_id: "t4", telecaller_name: "Sam", has_phone: false }),
      ],
      NOW,
    );
    expect(sent.map((s) => [s.batchId, s.popup])).toEqual([
      ["b2", false],
      ["b1", true],
    ]);
    expect(sent[1].recipients.map((r) => [r.name, r.delivery])).toEqual([
      ["Brindha", "read"],
      ["Kavya", "delivered"],
      ["Ravi", "sending"],
      ["Sam", "no_phone"],
    ]);
  });

  it("calls an uncollected message past its lifetime not reached", () => {
    const [s] = groupSent([row({ expires_at: new Date("2026-10-01T09:59:00Z") })], NOW);
    expect(s.recipients[0].delivery).toBe("not_reached");
  });
});
