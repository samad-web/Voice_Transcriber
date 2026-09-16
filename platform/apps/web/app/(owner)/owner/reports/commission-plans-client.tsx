"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  FormField,
  Input,
  Select,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useAlert,
} from "@aura/ui";
import {
  createCommissionPlanAction,
  deleteCommissionPlanAction,
  updateCommissionPlanAction,
  type CommissionPlan,
} from "./commission-actions";

interface Draft {
  name: string;
  metric: CommissionPlan["metric"];
  rateType: CommissionPlan["rate_type"];
  rate: string;
  active: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  metric: "won_value",
  rateType: "percent",
  rate: "",
  active: true,
};

const METRIC_LABEL: Record<CommissionPlan["metric"], string> = {
  won_value: "Won value",
  won_count: "Won deals",
  calls: "Calls",
};

function formatRate(plan: CommissionPlan): string {
  const n = Number(plan.rate);
  if (!Number.isFinite(n)) return "-";
  return plan.rate_type === "percent" ? `${n}%` : `${n} / ${plan.metric === "calls" ? "call" : "deal"}`;
}

/**
 * The rate calculator's config - name, metric, rate type, rate, active - for
 * the commission report on this same page to multiply against a window's
 * attainment. This panel only maintains the rate; see 0071's header and
 * ReportsService.commission() for why nothing here computes a payout.
 *
 * Same one-client-component-owns-list-and-dialog shape as ProductsClient.
 */
export function CommissionPlansClient({ plans }: { plans: CommissionPlan[] }) {
  const [editing, setEditing] = useState<CommissionPlan | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const openEdit = (plan: CommissionPlan) => {
    setEditing(plan);
    setDraft({
      name: plan.name,
      metric: plan.metric,
      rateType: plan.rate_type,
      rate: String(Number(plan.rate)),
      active: plan.active,
    });
    setOpen(true);
  };

  const save = () => {
    if (!draft.name.trim()) {
      void alert({
        title: "Couldn't save the commission plan",
        body: "Name is required",
        tone: "danger",
      });
      return;
    }
    const rate = Number(draft.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      void alert({
        title: "Couldn't save the commission plan",
        body: "Enter a rate greater than zero",
        tone: "danger",
      });
      return;
    }

    startTransition(async () => {
      const result = editing
        ? await updateCommissionPlanAction(editing.id, {
            name: draft.name.trim(),
            metric: draft.metric,
            rateType: draft.rateType,
            rate,
            active: draft.active,
          })
        : await createCommissionPlanAction({
            name: draft.name.trim(),
            metric: draft.metric,
            rateType: draft.rateType,
            rate,
            active: draft.active,
          });
      if (result.error) {
        await alert({
          title: "Couldn't save the commission plan",
          body: result.error,
          tone: "danger",
        });
        return;
      }
      setOpen(false);
    });
  };

  const remove = () => {
    if (!editing) return;
    startTransition(async () => {
      const result = await deleteCommissionPlanAction(editing.id);
      if (result.error) {
        await alert({
          title: "Couldn't delete the commission plan",
          body: result.error,
          tone: "danger",
        });
        return;
      }
      setOpen(false);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          A rate per org - commission is computed fresh on every report, never accrued or approved.
        </p>
        <Button type="button" size="sm" onClick={openCreate}>
          New plan
        </Button>
      </div>

      {plans.length === 0 ? (
        <EmptyState
          title="No commission plans yet"
          description="Set a rate against won value, won deals, or calls, and it applies to every export from here on."
          action={
            <Button type="button" size="sm" onClick={openCreate}>
              New plan
            </Button>
          }
        />
      ) : (
        <Table caption="Commission plans">
          <TableHead>
            <tr>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Metric</TableHeaderCell>
              <TableHeaderCell>Rate</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell>
                  <button
                    type="button"
                    onClick={() => openEdit(plan)}
                    className="block text-left font-medium text-text hover:underline"
                  >
                    {plan.name}
                  </button>
                </TableCell>
                <TableCell className="text-text-muted">{METRIC_LABEL[plan.metric]}</TableCell>
                <TableCell className="tabular-nums text-text-muted">{formatRate(plan)}</TableCell>
                <TableCell>
                  <StatusChip tone={plan.active ? "solid" : "outline"}>
                    {plan.active ? "active" : "inactive"}
                  </StatusChip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit commission plan" : "New commission plan"}
        footer={
          <>
            {editing ? (
              <Button
                type="button"
                variant="danger"
                loading={pending}
                onClick={remove}
                className="mr-auto"
              >
                Delete
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" loading={pending} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="Name" name="name" required>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Paid on" name="metric" required>
              <Select
                value={draft.metric}
                onChange={(e) =>
                  setDraft({ ...draft, metric: e.target.value as CommissionPlan["metric"] })
                }
              >
                <option value="won_value">Won value</option>
                <option value="won_count">Won deals</option>
                <option value="calls">Calls</option>
              </Select>
            </FormField>
            <FormField label="Rate type" name="rateType" required>
              <Select
                value={draft.rateType}
                onChange={(e) =>
                  setDraft({ ...draft, rateType: e.target.value as CommissionPlan["rate_type"] })
                }
              >
                <option value="percent">Percent</option>
                <option value="flat_per_unit">Flat per unit</option>
              </Select>
            </FormField>
          </div>

          <FormField
            label={draft.rateType === "percent" ? "Rate (%)" : "Rate (amount per unit)"}
            name="rate"
            required
          >
            <Input
              type="number"
              min="0"
              step="0.01"
              value={draft.rate}
              onChange={(e) => setDraft({ ...draft, rate: e.target.value })}
            />
          </FormField>

          <Checkbox
            label="Active"
            description="Inactive plans stay on record but drop out of the commission report."
            checked={draft.active}
            onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
          />
        </div>
      </Dialog>
    </div>
  );
}
