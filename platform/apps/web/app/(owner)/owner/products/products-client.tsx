"use client";

import { useState, useTransition } from "react";
import {
  Button,
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
} from "@aura/ui";
import { createProductAction, updateProductAction, type Product } from "./actions";
import { formatMoney } from "../lib/format-money";

interface Draft {
  name: string;
  sku: string;
  description: string;
  unitPrice: string;
  currency: string;
  taxRate: string;
  status: "active" | "archived";
}

const EMPTY_DRAFT: Draft = {
  name: "",
  sku: "",
  description: "",
  unitPrice: "",
  currency: "INR",
  taxRate: "",
  status: "active",
};

/**
 * The product list, plus the create/edit dialog - one client component, the
 * way ConnectionsManager and Inbox own their own list + form. The list itself
 * needs no interactivity beyond opening the dialog, so it lives here rather
 * than in the server page for that one reason: a row's name opens the same
 * dialog a "New Product" click does.
 */
export function ProductsClient({ products }: { products: Product[] }) {
  const [editing, setEditing] = useState<Product | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setError(null);
    setOpen(true);
  };

  const openEdit = (product: Product) => {
    setEditing(product);
    setDraft({
      name: product.name,
      sku: product.sku ?? "",
      description: product.description ?? "",
      unitPrice: String(Number(product.unit_price)),
      currency: product.currency,
      taxRate: String(Number(product.tax_rate)),
      status: product.status,
    });
    setError(null);
    setOpen(true);
  };

  const save = () => {
    setError(null);
    if (!draft.name.trim()) {
      setError("Name is required");
      return;
    }
    const unitPrice = Number(draft.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setError("Enter a valid unit price");
      return;
    }
    const taxRate = Number(draft.taxRate || 0);
    if (!Number.isFinite(taxRate) || taxRate < 0) {
      setError("Enter a valid tax rate");
      return;
    }
    if (!draft.currency.trim()) {
      setError("Currency is required");
      return;
    }

    startTransition(async () => {
      const result = editing
        ? await updateProductAction(editing.id, {
            name: draft.name.trim(),
            sku: draft.sku.trim() || undefined,
            description: draft.description.trim() || undefined,
            unitPrice,
            currency: draft.currency.trim(),
            taxRate,
            status: draft.status,
          })
        : await createProductAction({
            name: draft.name.trim(),
            sku: draft.sku.trim() || undefined,
            description: draft.description.trim() || undefined,
            unitPrice,
            currency: draft.currency.trim(),
            taxRate,
          });
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" onClick={openCreate}>
          New Product
        </Button>
      </div>

      {products.length === 0 ? (
        <EmptyState
          title="No products yet"
          description="Add the things you sell - quotations and invoices pick their line items from this list."
          action={
            <Button type="button" size="sm" onClick={openCreate}>
              New Product
            </Button>
          }
        />
      ) : (
        <Table caption="Products">
          <TableHead>
            <tr>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>SKU</TableHeaderCell>
              <TableHeaderCell>Price</TableHeaderCell>
              <TableHeaderCell>Tax</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {products.map((product) => (
              <TableRow key={product.id}>
                <TableCell>
                  <button
                    type="button"
                    onClick={() => openEdit(product)}
                    className="block text-left font-medium text-text hover:underline"
                  >
                    {product.name}
                  </button>
                </TableCell>
                <TableCell className="text-text-muted">{product.sku ?? "-"}</TableCell>
                <TableCell className="tabular-nums text-text-muted">
                  {formatMoney(product.unit_price, product.currency)}
                </TableCell>
                <TableCell className="tabular-nums text-text-muted">
                  {Number(product.tax_rate)}%
                </TableCell>
                <TableCell>
                  <StatusChip tone={product.status === "active" ? "solid" : "outline"}>
                    {product.status}
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
        title={editing ? "Edit product" : "New product"}
        footer={
          <>
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
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text"
            >
              {error}
            </p>
          ) : null}

          <FormField label="Name" name="name" required>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </FormField>

          <FormField label="SKU" name="sku">
            <Input value={draft.sku} onChange={(e) => setDraft({ ...draft, sku: e.target.value })} />
          </FormField>

          <FormField label="Description" name="description">
            <textarea
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={3}
              className="w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted hover:border-text-subtle"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Unit price" name="unitPrice" required>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={draft.unitPrice}
                onChange={(e) => setDraft({ ...draft, unitPrice: e.target.value })}
              />
            </FormField>
            <FormField label="Currency" name="currency" required>
              <Input
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
              />
            </FormField>
          </div>

          <FormField label="Tax rate (%)" name="taxRate">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={draft.taxRate}
              onChange={(e) => setDraft({ ...draft, taxRate: e.target.value })}
            />
          </FormField>

          {editing ? (
            <FormField label="Status" name="status">
              <Select
                value={draft.status}
                onChange={(e) =>
                  setDraft({ ...draft, status: e.target.value as "active" | "archived" })
                }
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </Select>
            </FormField>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
