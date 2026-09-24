import type { InvoiceStatus } from "./actions";

/**
 * The status changes a person may make by hand - a mirror of
 * MANUAL_STATUS_MOVES in apps/api/src/modules/invoices/invoices.controller.ts,
 * which is what actually enforces it (409 on anything else). `paid` is never a
 * target: only a recorded payment makes an invoice paid.
 *
 * Its own module because a "use server" file (actions.ts) may export only
 * async functions.
 */
const MANUAL_STATUS_MOVES: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ["sent", "void"],
  sent: ["overdue", "void"],
  overdue: ["sent", "void"],
  paid: [],
  void: [],
};

/** The current status first, then every status it may move to by hand. */
export function selectableStatuses(current: InvoiceStatus): InvoiceStatus[] {
  return [current, ...MANUAL_STATUS_MOVES[current]];
}
