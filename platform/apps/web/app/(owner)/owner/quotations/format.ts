/**
 * Money fields come back from the API as Postgres numeric strings
 * (`quotation.total`, `item.line_total`, …) — this is the one place in the
 * feature that turns one into a display string, shared by the list and the
 * detail page.
 */
export function formatMoney(amount: string | number | null | undefined, currency: string): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}
