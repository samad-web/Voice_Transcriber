"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Card, Input, Label, MonoLabel, Select, StatusChip, useAlert } from "@aura/ui";
import {
  clearCampaignSpendAction,
  listCampaignSpendAction,
  setCampaignSpendAction,
  type CampaignRow,
  type CampaignSpendMonth,
} from "./actions";

/**
 * What each campaign cost, month by month (migration 0171, Build docs/41 E4).
 *
 * ── WHY THIS PANEL EXISTS AT ALL ────────────────────────────────────────────
 *
 * The Performance page divides a reporting window's leads by a campaign's
 * spend. Until 0171 the only spend in the schema was a LIFETIME total, so a
 * campaign running since March reported its cost per lead on a seven-day page
 * against six months of spend - a number that is wrong in a direction that
 * gets working campaigns switched off.
 *
 * 0171 records spend per calendar month. This is where it gets entered. It is
 * on Lead sources rather than on the Performance page itself for two reasons:
 * campaigns are a lead-source concept, and marketing may open this page while
 * Performance is owner/manager only - the person who knows what an ad set cost
 * is usually neither of those.
 *
 * ── WHY A MONTH AND NOT A DATE RANGE ────────────────────────────────────────
 *
 * Two overlapping periods double-count their overlap, silently, in a figure
 * somebody moves a budget on. A month grain makes that unrepresentable rather
 * than merely forbidden (0171's header has the full reasoning), and it matches
 * where the numbers come from: every ad platform and every agency invoice
 * reports by calendar month.
 *
 * ── RENDERS NOTHING WHEN THERE ARE NO CAMPAIGNS ─────────────────────────────
 *
 * Campaigns have no create surface in this console today - they arrive through
 * the API, or by being attached to a lead source. An empty panel inviting
 * somebody to enter spend for a campaign they have no way to make would be a
 * dead end, so the panel stays hidden until there is one.
 */
export function CampaignSpendPanel({ campaigns }: { campaigns: CampaignRow[] }) {
  const active = campaigns.filter((c) => c.active);
  const [selected, setSelected] = useState(active[0]?.id ?? "");
  const [months, setMonths] = useState<CampaignSpendMonth[] | null>(null);
  const [month, setMonth] = useState(thisMonth());
  const [amount, setAmount] = useState("");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const campaign = active.find((c) => c.id === selected) ?? null;

  // Reloaded on every campaign change rather than fetched once for all of
  // them: a workspace may have dozens of campaigns with years of months, and
  // this panel is opened to correct one of them.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setMonths(null);
    void listCampaignSpendAction(selected).then((result) => {
      if (cancelled) return;
      setMonths(result.data?.months ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (active.length === 0) return null;

  const save = () => {
    if (!campaign) return;
    if (!/^\d{1,12}(\.\d{1,2})?$/u.test(amount)) {
      void alert({
        title: "That amount will not save",
        body: "Enter a number, with up to two decimal places. Zero is allowed and means the campaign ran and cost nothing that month.",
        tone: "danger",
      });
      return;
    }
    startTransition(async () => {
      const result = await setCampaignSpendAction(campaign.id, month, amount, campaign.spend_currency);
      if (result.error) {
        await alert({ title: "Couldn't save that month", body: result.error, tone: "danger" });
        return;
      }
      setAmount("");
      const refreshed = await listCampaignSpendAction(campaign.id);
      setMonths(refreshed.data?.months ?? []);
    });
  };

  const clear = (target: string) => {
    if (!campaign) return;
    startTransition(async () => {
      const result = await clearCampaignSpendAction(campaign.id, target);
      if (result.error) {
        await alert({ title: "Couldn't remove that month", body: result.error, tone: "danger" });
        return;
      }
      const refreshed = await listCampaignSpendAction(campaign.id);
      setMonths(refreshed.data?.months ?? []);
    });
  };

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <MonoLabel>Campaign spend</MonoLabel>
        {months != null ? (
          <StatusChip tone={months.length > 0 ? "solid" : "outline"}>
            {months.length > 0 ? "Monthly spend recorded" : "All-time total only"}
          </StatusChip>
        ) : null}
      </div>

      <p className="max-w-2xl text-sm text-text-muted">
        What each campaign cost, month by month. Performance uses the months your reporting range
        covers, apportioned by day, so a week&rsquo;s leads are measured against a week&rsquo;s
        spend. Until a campaign has at least one month here, its cost per lead and return are
        worked out from its all-time total instead, which reads low for anything long-running.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="campaign-spend-source">Campaign</Label>
          <Select
            id="campaign-spend-source"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.channel ? ` — ${c.channel}` : ""}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>All-time total on record</Label>
          <p className="pt-2 text-sm text-text-muted">
            {campaign?.spend_amount ? campaign.spend_amount : "None entered"}
            {campaign?.spend_currency ? ` ${campaign.spend_currency}` : ""}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="campaign-spend-month">Month</Label>
          <Input
            id="campaign-spend-month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="campaign-spend-amount">Spend</Label>
          <Input
            id="campaign-spend-amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <Button onClick={save} disabled={pending || !campaign || month === ""}>
          {months?.some((m) => m.month === month) ? "Update month" : "Add month"}
        </Button>
      </div>

      {months == null ? (
        <p className="text-sm text-text-muted">Loading this campaign&rsquo;s months…</p>
      ) : months.length === 0 ? (
        <p className="text-sm text-text-muted">
          No months recorded for this campaign yet.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="pb-1 font-medium text-text-muted">Month</th>
              <th className="pb-1 text-right font-medium text-text-muted">Spend</th>
              <th className="pb-1" />
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}>
                <td className="py-1 text-text">{m.month}</td>
                <td className="py-1 text-right text-text">{m.amount}</td>
                <td className="py-1 text-right">
                  <Button variant="ghost" size="sm" onClick={() => clear(m.month)} disabled={pending}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* The distinction is small and it is the one people get wrong, so it is
          written down where the Remove button is rather than in a tooltip. */}
      <p className="border-t border-border pt-3 text-xs text-text-subtle">
        Zero and no row mean different things. Zero says the campaign ran and cost nothing that
        month; removing a month says nobody has recorded what it cost. Remove every month and this
        campaign goes back to being measured against its all-time total.
      </p>
    </Card>
  );
}

/** The current month as `YYYY-MM`, in the reader's own calendar. */
function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
