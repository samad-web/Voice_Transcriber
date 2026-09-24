"use client";

import { useEffect, useState, useTransition } from "react";
import { useServerState } from "@/lib/use-server-state";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookmarkPlus, Settings2 } from "lucide-react";
import { Button, Dialog, Input, useAlert, useConfirm, useToast } from "@aura/ui";
import {
  LIST_DEFINITIONS,
  activeSavedView,
  hasSavableFilters,
  viewHref,
  type ListKey,
  type SavedView,
} from "@/lib/list-views";
import { createSavedViewAction, deleteSavedViewAction, renameSavedViewAction } from "./actions";

/**
 * A list's saved views as a row of tabs, with "Save view" for the filters on
 * screen.
 *
 * ── TABS ARE LINKS ──────────────────────────────────────────────────────────
 *
 * Opening a view is a navigation to its query string (lib/list-views.ts), so a
 * view behaves exactly like the same filters set by hand: the back button
 * returns to where you were, the URL can be shared, and the list endpoint runs
 * under the viewer's own permissions. Nothing is cached in the tab.
 *
 * The active tab is whichever view the CURRENT URL equals. Change a filter
 * after opening one and no tab is active any more - the list on screen is no
 * longer that view - and "Save view" offers to keep the new one.
 *
 * `current` is the normalised query the server page read, rather than
 * useSearchParams here, so the bar renders on the server with the page and
 * needs no Suspense boundary.
 *
 * Tabs are neutral ink, not a hue: "this view is selected" is not one of the
 * console's four states (@aura/ui state.tsx).
 */
export function SavedViewsBar({
  list,
  views: initial,
  current,
  allLabel,
}: {
  list: ListKey;
  views: SavedView[];
  current: Record<string, string>;
  /** The unfiltered tab, e.g. "All deals". */
  allLabel: string;
}) {
  const router = useRouter();
  const alert = useAlert();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [views, setViews] = useServerState(initial, pending);
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => setViews(initial), [initial]);

  const active = activeSavedView(list, views, current);
  const filtered = hasSavableFilters(list, current);
  const canSave = filtered && !active;
  const filterCount = Object.keys(current).length;

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await createSavedViewAction(list, trimmed, current);
      if (result.error || !result.view) {
        await alert({ title: "Couldn't save the view", body: result.error ?? "Try again.", tone: "danger" });
        return;
      }
      setViews((prev) => [...prev, result.view!]);
      setSaving(false);
      setName("");
      toast(`Saved "${result.view.name}"`);
      router.refresh();
    });
  };

  const tab = (href: string, label: string, isActive: boolean, key: string) => (
    <Link
      key={key}
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={`inline-flex h-9 shrink-0 items-center border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150 ease-out ${
        isActive
          ? "border-text font-medium text-text"
          : "border-transparent text-text-muted hover:border-border-strong hover:text-text"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-border">
      <nav aria-label="Saved views" className="-mb-px flex min-w-0 flex-1 overflow-x-auto">
        {tab(LIST_DEFINITIONS[list].path, allLabel, !filtered, "all")}
        {views.map((view) => tab(viewHref(list, view.query), view.name, active?.id === view.id, view.id))}
      </nav>
      <div className="flex shrink-0 items-center gap-1 pb-1.5">
        {canSave ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setSaving(true)}>
            <BookmarkPlus aria-hidden="true" className="h-3.5 w-3.5" />
            Save view
          </Button>
        ) : null}
        {views.length > 0 ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setManaging(true)} aria-label="Manage saved views">
            <Settings2 aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Manage</span>
          </Button>
        ) : null}
      </div>

      <Dialog
        open={saving}
        onClose={() => setSaving(false)}
        title="Save this view"
        description={`Keeps the ${filterCount} filter${filterCount === 1 ? "" : "s"} and sort on screen as a tab. Only you see your views, and each one shows whatever those filters match when you open it.`}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setSaving(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={save} loading={pending} disabled={!name.trim()}>
              Save view
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label htmlFor="saved-view-name" className="text-sm font-medium text-text">
            Name
          </label>
          <Input
            id="saved-view-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. My stale deals"
            autoFocus
            className="mt-1.5"
          />
        </form>
      </Dialog>

      <ManageViewsDialog
        list={list}
        open={managing}
        views={views}
        onClose={() => setManaging(false)}
        onRenamed={(view) => setViews((prev) => prev.map((v) => (v.id === view.id ? view : v)))}
        onDeleted={(id) => {
          setViews((prev) => prev.filter((v) => v.id !== id));
          router.refresh();
        }}
      />
    </div>
  );
}

function ManageViewsDialog({
  list,
  open,
  views,
  onClose,
  onRenamed,
  onDeleted,
}: {
  list: ListKey;
  open: boolean;
  views: SavedView[];
  onClose: () => void;
  onRenamed: (view: SavedView) => void;
  onDeleted: (id: string) => void;
}) {
  const alert = useAlert();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const rename = () => {
    if (!editing || !editing.name.trim()) return;
    startTransition(async () => {
      const result = await renameSavedViewAction(list, editing.id, editing.name.trim());
      if (result.error || !result.view) {
        await alert({ title: "Couldn't rename the view", body: result.error ?? "Try again.", tone: "danger" });
        return;
      }
      onRenamed(result.view);
      setEditing(null);
    });
  };

  const remove = async (view: SavedView) => {
    const ok = await confirm({
      title: `Delete "${view.name}"?`,
      body: "Only the tab goes. No records change, and you can save the same filters again.",
      confirmLabel: "Delete view",
      tone: "danger",
      // A bookmark, not data: the typed-word gate would train people to type
      // DELETE without reading it (confirm.tsx).
      requireTyped: false,
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteSavedViewAction(list, view.id);
      if (result.error) {
        await alert({ title: "Couldn't delete the view", body: result.error, tone: "danger" });
        return;
      }
      onDeleted(view.id);
    });
  };

  return (
    <Dialog open={open} onClose={onClose} title="Your saved views">
      {views.length === 0 ? (
        <p className="text-sm text-text-muted">No saved views on this list.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {views.map((view) => (
            <li key={view.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              {editing?.id === view.id ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename();
                  }}
                >
                  <Input
                    value={editing.name}
                    onChange={(e) => setEditing({ id: view.id, name: e.target.value })}
                    maxLength={60}
                    aria-label={`New name for ${view.name}`}
                    autoFocus
                  />
                  <Button type="submit" size="sm" loading={pending}>
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{view.name}</span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing({ id: view.id, name: view.name })}>
                    Rename
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void remove(view)}>
                    Delete
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
