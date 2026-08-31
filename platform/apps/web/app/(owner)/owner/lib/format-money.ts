/**
 * Money fields come back from the API as Postgres numeric strings
 * (`invoice.total`, `quotation.total`, `payment.amount`, `product.unit_price`,
 * …) — this is the one place across the owner console that turns one into a
 * display string. Previously implemented three times near-verbatim
 * (invoices/format.ts, quotations/format.ts, products-client.tsx); this is
 * the shared version all three now import, alongside api-error.ts and
 * oauth-redirect.ts in this same directory.
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
