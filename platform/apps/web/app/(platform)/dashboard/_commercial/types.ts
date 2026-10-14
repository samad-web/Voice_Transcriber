/**
 * The shape `GET /v1/admin/commercial` returns (doc 49 P13c).
 *
 * Every block carries an `evidence` sentence, and the console RENDERS it rather
 * than dropping it. That is not padding: three of the figures on this screen
 * are weaker than they look - billings standing in for MRR, unsettled standing
 * in for overdue, and a churn count that is a proxy - and a commercial number
 * whose method is invisible gets argued with instead of acted on.
 */

export interface CurrencyTotal {
  currency: string;
  recurringMinor: number;
  atRiskMinor: number;
  recurringClients: number;
  atRiskClients: number;
}

export type MrrState =
  | "recurring"
  | "at_risk"
  | "trialing"
  | "cancelled"
  | "no_subscription"
  | "unpriced";

export interface CommercialClient {
  orgId: string;
  name: string;
  status: string;
  region: string;
  enabledModules: string[];
  createdAt: string;
  onboardedBy: string | null;
  onboardedByRole: string | null;
  planKey: string | null;
  planName: string | null;
  planFamily: string | null;
  subStatus: string | null;
  billingPeriod: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  mrr: { state: MrrState; minor: number; currency: string | null };
  unpricedAddons: string[];
  capture: { usedMinutes: number; limitMinutes: number | null; overLimit: boolean };
  lastCallAt: string | null;
  transcription24h: { audioCalls: number; complete: number; rateBp: number | null };
  unsettled: { orders: number; minor: number; oldestAt: string | null };
  lastOrderStatus: string | null;
  openIncidents: number;
}

export interface LifecycleStepOut {
  key: string;
  label: string;
  count: number;
  evidence: string;
  ofPreviousBp: number | null;
  ofFirstBp: number | null;
}

export interface Commercial {
  scope: string | null;
  scopeNote: string | null;
  /** Decided in the API from the environment, never asserted by the browser. */
  isRoot: boolean;

  mrr: {
    byCurrency: CurrencyTotal[];
    trialing: number;
    cancelled: number;
    noSubscription: number;
    unpriced: number;
    unpricedAddons: string[];
    evidence: string;
  };
  clientCounts: { total: number; active: number; suspended: number; churned: number };
  netNew: {
    newThisMonth: number;
    newLastMonth: number;
    deltaBp: number | null;
    churnedThisMonth: number;
    churnedTotal: number;
    net: number;
    churnIsProxy: boolean;
    evidence: string;
  };
  unsettled: { minor: number; orders: number; oldestAt: string | null; evidence: string };
  capture: {
    clientsWithLimit: number;
    usedMinutes: number;
    limitMinutes: number;
    overLimit: number;
    under25pct: number;
    evidence: string;
  };

  billingsByMonth: {
    months: Array<{
      month: string;
      byPlan: Array<{ planKey: string; currency: string; minor: number; orders: number }>;
      totalsByCurrency: Array<{ currency: string; minor: number }>;
    }>;
    evidence: string;
  };
  lifecycle: { steps: LifecycleStepOut[]; paidNeverProvisioned: number; evidence: string };
  concentration: {
    byCurrency: Array<{
      currency: string;
      largestBp: number;
      topThreeBp: number;
      clients: number;
      largest: { name: string; minor: number } | null;
    }>;
    evidence: string;
  };

  transcription24h: {
    audioCalls: number;
    complete: number;
    rateBp: number | null;
    evidence: string;
  };
  incidents: {
    rows: Array<{
      category: string;
      reason: string | null;
      tickets: number;
      occurrences: number;
      oldestAt: string | null;
      latestAt: string | null;
    }>;
    tickets: number;
    occurrences: number;
    evidence: string;
  };

  clients: CommercialClient[];
}
