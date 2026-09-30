"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Button, Input, Popover } from "@aura/ui";
import { formatMoney } from "./lib/format-money";
import { searchProductsAction, type Product } from "./products/actions";

/** Long enough that typing a name doesn't fire a request per keystroke. */
const DEBOUNCE_MS = 250;

/**
 * Add a line to a quotation or an invoice from the price list.
 *
 * ── WHAT WAS BROKEN ────────────────────────────────────────────────────────
 *
 * Nothing. There was no wire to break. `products` (migration 0059) shipped with
 * `quotation_items.product_id`, a `productId` on both controllers' line-item
 * schemas, an `assertInOrg` check that a line's product belongs to the caller's
 * org, and `productId` on the web's own row model - and no control anywhere that
 * could set it. Every line on every quotation and invoice was retyped by hand
 * and every `product_id` was NULL, while the price-list page's empty state said
 * "quotations and invoices pick their line items from this list". This component
 * is the half that was missing, not a repair of a half that had regressed.
 *
 * ── WHY THE FIRST PAGE ARRIVES AS A PROP ───────────────────────────────────
 *
 * `initialProducts` is fetched by the server page that renders the editor, so
 * opening this costs nothing: the list is already on the client before the
 * button is clicked. The server round trip only happens once somebody types,
 * and only for what they typed. That prop is also the permission signal - a
 * role without `product:view` gets `null`, and a control that could only ever
 * 403 is not rendered at all.
 *
 * ── WHY IT STAYS OPEN AFTER A PICK ─────────────────────────────────────────
 *
 * A quotation is usually several catalogue lines in a row. RecordPicker closes
 * on selection because it fills one field; this appends one line of many, so it
 * clears the query and keeps focus in the search box. Escape is how you finish.
 */
export function PriceListPicker({
  currency,
  initialProducts,
  disabled,
  onPick,
}: {
  /** The document's currency. A product priced in another one does not bring its price across. */
  currency: string;
  /** The first page of the active price list, or `null` when this person may not read it. */
  initialProducts: Product[] | null;
  disabled?: boolean;
  onPick: (product: Product) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Product[] | null>(initialProducts);
  const [active, setActive] = useState(0);
  const [added, setAdded] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Debounced search. An empty box is the server-rendered first page again
  // rather than a request that would return exactly that.
  useEffect(() => {
    if (!open) return;
    if (query.trim() === "") {
      setOptions(initialProducts);
      return;
    }
    setOptions(null);
    const timer = setTimeout(() => {
      void searchProductsAction(query).then((result) => {
        setOptions(result.products ?? []);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open, initialProducts]);

  // The arrow keys steer an index into `options`; reset it whenever that list
  // changes underneath them.
  useEffect(() => {
    setActive(0);
  }, [options]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // A person who may not read the price list gets no dead control.
  if (initialProducts === null) return null;

  // An empty catalogue is a different problem from a missing one, and a search
  // box over nothing does not solve it.
  if (initialProducts.length === 0) {
    return (
      <p className="text-xs text-text-muted">
        Your price list is empty -{" "}
        <Link href="/owner/products" className="font-medium text-text hover:underline">
          add what you sell
        </Link>{" "}
        and lines can be picked from it.
      </p>
    );
  }

  const choose = (product: Product) => {
    onPick(product);
    // Confirmation that the click landed: the panel does not close, so without
    // this nothing on screen changes where the person is looking.
    setAdded(product.name);
    setQuery("");
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!options || options.length === 0) return;
      setActive((i) =>
        event.key === "ArrowDown"
          ? (i + 1) % options.length
          : (i - 1 + options.length) % options.length,
      );
      return;
    }
    if (event.key === "Enter" && options?.[active]) {
      event.preventDefault();
      choose(options[active]);
    }
  };

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <Popover
      open={open}
      onDismiss={() => setOpen(false)}
      align="start"
      className="w-80 p-2"
      trigger={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => {
            setQuery("");
            setAdded(null);
            setOpen((wasOpen) => !wasOpen);
          }}
        >
          Add from price list
        </Button>
      }
    >
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options?.[active] ? optionId(active) : undefined}
        aria-label="Search the price list"
        autoComplete="off"
        value={query}
        placeholder="Name or SKU…"
        onKeyDown={onKeyDown}
        onChange={(e) => setQuery(e.target.value)}
      />

      <ul id={listId} role="listbox" aria-label="Price list" className="mt-1 max-h-56 overflow-y-auto">
        {options === null ? (
          // `role="presentation"`: a listbox may only hold options and groups,
          // and "Searching…" is status, not a choice.
          <li role="presentation" className="px-2 py-2 text-xs text-text-muted">
            Searching…
          </li>
        ) : options.length === 0 ? (
          <li role="presentation" className="px-2 py-2 text-xs text-text-muted">
            Nothing in your price list matches that.
          </li>
        ) : (
          options.map((product, i) => {
            const otherCurrency =
              product.currency.trim().toUpperCase() !== currency.trim().toUpperCase();
            return (
              <li
                key={product.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                // onMouseDown, not onClick: mousedown fires before the input
                // blurs, so the pick lands instead of the panel closing out from
                // under the pointer. Same reason record-picker.tsx uses it.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(product);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer rounded-sm px-2 py-1.5 ${i === active ? "bg-surface-hover" : ""}`}
              >
                <span className="block truncate text-xs font-medium text-text">{product.name}</span>
                <span className="block truncate text-xs text-text-muted tabular-nums">
                  {formatMoney(product.unit_price, product.currency)}
                  {Number(product.tax_rate) > 0 ? ` + ${Number(product.tax_rate)}% tax` : ""}
                  {product.sku ? ` · ${product.sku}` : ""}
                </span>
                {otherCurrency ? (
                  <span className="block text-xs text-text-muted">
                    Priced in {product.currency} - enter the {currency} amount yourself.
                  </span>
                ) : null}
              </li>
            );
          })
        )}
      </ul>

      {/* The live region stays mounted whether or not it has anything to say:
          a region that appears at the same moment its text does is announced
          unreliably, which is the whole point of having one. */}
      <p role="status" aria-live="polite" className="sr-only">
        {added ? `Added ${added} to the line items.` : ""}
      </p>
      {added ? (
        <p aria-hidden="true" className="mt-1 border-t border-border px-2 pt-2 text-xs text-text-muted">
          Added {added}. Pick another, or press Escape.
        </p>
      ) : null}
    </Popover>
  );
}
