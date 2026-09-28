"use client";

import { useRouter } from "next/navigation";
import { Select } from "@aura/ui";

/**
 * "Everyone" or one telecaller, kept in the URL like the date range so a
 * filtered timesheet is a link that can be shared. Navigates through the
 * router, which adds the console's basePath - a plain GET form would not.
 */
export function PersonFilter({
  people,
  value,
  hrefFor,
}: {
  people: { id: string; name: string }[];
  value: string;
  /** The page's href with `telecallerId` set (or cleared, for ""). Built on the server. */
  hrefFor: Record<string, string>;
}) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm text-text-muted">
      Telecaller
      <Select
        size="sm"
        className="w-56"
        value={value}
        onChange={(e) => {
          const href = hrefFor[e.target.value];
          if (href) router.push(href);
        }}
      >
        <option value="">Everyone</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </label>
  );
}
