"use client";

import Link from "next/link";
import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Popover } from "@aura/ui";
import { FilterTag } from "@/components/filter-tag";
import { formatDateRange } from "@/lib/report-dashboard";
import { dealsHref, type DealsState } from "./deals-url";

type Choice = { value: string; label: string };
const labelFor = (choices: readonly Choice[], value: string | null) =>
  value ? (choices.find((c) => c.value === value)?.label ?? value) : null;

/**
 * The row this page didn't have before: every active filter as one removable
 * tag (Calls' `FilterTag`, point 6 of that brief), and "Idle N+ days" (point
 * 5 - specific enough to live behind a button) tucked into an Advanced
 * filters popover instead of its own always-visible chip.
 *
 * Every control here is still a plain `<Link>`: Deals' whole filter state
 * already lives in the URL (deals-url.ts), and a tag removes itself the same
 * way the pipeline picker and the view toggle already navigate - no client
 * state to keep in step with it.
 */
export function DealsAdvancedFilters({
  current,
  staleAfterDays,
  stageChoices,
  statusChoices,
  ownerChoices,
  tagChoices,
}: {
  current: DealsState;
  staleAfterDays: number;
  stageChoices: readonly Choice[];
  statusChoices: readonly Choice[];
  ownerChoices: readonly Choice[];
  tagChoices: readonly Choice[];
}) {
  const [open, setOpen] = useState(false);

  const tags: { key: string; label: string; href: string }[] = [];
  const stageLabel = labelFor(stageChoices, current.stage);
  if (stageLabel) tags.push({ key: "stage", label: `Stage: ${stageLabel}`, href: dealsHref(current, { stage: null }) });
  const statusLabel = labelFor(statusChoices, current.status);
  if (statusLabel)
    tags.push({ key: "status", label: `Status: ${statusLabel}`, href: dealsHref(current, { status: null }) });
  const ownerLabel = labelFor(ownerChoices, current.owner);
  if (ownerLabel) tags.push({ key: "owner", label: `Owner: ${ownerLabel}`, href: dealsHref(current, { owner: null }) });
  const tagLabel = labelFor(tagChoices, current.tagId);
  if (tagLabel) tags.push({ key: "tag", label: `Tag: ${tagLabel}`, href: dealsHref(current, { tagId: null }) });
  if (current.staleOnly)
    tags.push({
      key: "stale",
      label: `Idle ${staleAfterDays}+ days`,
      href: dealsHref(current, { staleOnly: false }),
    });
  if (current.createdFrom || current.createdTo)
    tags.push({
      key: "created",
      label: `Created: ${formatDateRange(
        current.createdFrom ?? current.createdTo!,
        current.createdTo ?? current.createdFrom!,
      )}`,
      href: dealsHref(current, { createdFrom: null, createdTo: null }),
    });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <FilterTag key={tag.key} label={tag.label} href={tag.href} />
      ))}

      <Popover
        open={open}
        onDismiss={() => setOpen(false)}
        align="end"
        className="w-56 p-2"
        trigger={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
              current.staleOnly
                ? "border-transparent bg-text text-bg"
                : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            Advanced filters
          </button>
        }
      >
        <Link
          href={dealsHref(current, { staleOnly: !current.staleOnly })}
          onClick={() => setOpen(false)}
          aria-current={current.staleOnly ? "true" : undefined}
          className={`block rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors duration-150 ease-out ${
            current.staleOnly ? "bg-text font-medium text-bg" : "text-text hover:bg-surface-hover"
          }`}
        >
          Idle {staleAfterDays}+ days
        </Link>
      </Popover>
    </div>
  );
}
