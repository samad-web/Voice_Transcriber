import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// `next/link` wants the app router's context, which a bare renderToStaticMarkup
// has no way to provide. The thing under test is which href is chosen and which
// name wins - not Link's own behaviour - so it stands in as a plain anchor.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));

const { CustomerCell } = await import("./customer-cell");

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("CustomerCell", () => {
  it("shows the company, linked, when there is one", () => {
    const html = renderToStaticMarkup(
      <CustomerCell
        accountId={ACCOUNT}
        accountName="Acme Pvt Ltd"
        contactId={CONTACT}
        contactName="Priya Nair"
      />,
    );

    // The company wins over the person: that is the order a document is
    // addressed in.
    expect(html).toContain("Acme Pvt Ltd");
    expect(html).not.toContain("Priya Nair");
    expect(html).toContain(`/owner/accounts/${ACCOUNT}`);
  });

  it("falls back to the person when no company is attached", () => {
    const html = renderToStaticMarkup(
      <CustomerCell accountId={null} accountName={null} contactId={CONTACT} contactName="Priya Nair" />,
    );

    expect(html).toContain("Priya Nair");
    expect(html).toContain(`/owner/contacts/${CONTACT}`);
  });

  it("is a dash when the document is for nobody yet", () => {
    const html = renderToStaticMarkup(
      <CustomerCell accountId={null} accountName={null} contactId={null} contactName={null} />,
    );

    expect(html).toBe("-");
  });

  it("is a dash when the API did not join the names, rather than a uuid", () => {
    // An older API response, or a mutation's echo, carries the ids without the
    // names. Printing the id was the bug this whole column replaced, so the
    // absence of a name must never fall back to one.
    const html = renderToStaticMarkup(
      <CustomerCell accountId={ACCOUNT} contactId={CONTACT} />,
    );

    expect(html).toBe("-");
    expect(html).not.toContain(ACCOUNT);
  });

  it("renders a name with no id as plain text rather than a broken link", () => {
    const html = renderToStaticMarkup(
      <CustomerCell accountId={null} accountName="Acme Pvt Ltd" contactId={null} contactName={null} />,
    );

    expect(html).toContain("Acme Pvt Ltd");
    expect(html).not.toContain("<a");
  });
});
