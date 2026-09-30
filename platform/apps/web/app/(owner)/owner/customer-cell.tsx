import Link from "next/link";

/**
 * Who a quotation or invoice is for, in one table cell.
 *
 * Both lists used to show a document number, a status and an amount and nothing
 * about the customer, so forty rows of `Q-2026-0007` had to be opened one at a
 * time to find the one you wanted. The name is resolved by the list endpoints'
 * LEFT JOIN (there is no name on the row itself), which is why this is only
 * ever rendered from a list - a detail screen resolves a name through
 * `RecordPicker` instead.
 *
 * The company takes precedence over the person: that is the order a document is
 * addressed in. A document raised against a contact with no company still says
 * whose it is rather than falling back to a dash.
 */
export function CustomerCell({
  accountId,
  accountName,
  contactId,
  contactName,
}: {
  accountId: string | null;
  accountName?: string | null;
  contactId: string | null;
  contactName?: string | null;
}) {
  const name = accountName ?? contactName ?? null;
  if (!name) return <>-</>;

  const href =
    accountName && accountId
      ? `/owner/accounts/${accountId}`
      : contactName && contactId
        ? `/owner/contacts/${contactId}`
        : null;

  if (!href) return <>{name}</>;
  return (
    <Link href={href} className="hover:underline">
      {name}
    </Link>
  );
}
