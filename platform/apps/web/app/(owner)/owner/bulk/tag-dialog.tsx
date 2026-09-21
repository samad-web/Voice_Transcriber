"use client";

import { useEffect, useState } from "react";
import { Button, Dialog, ErrorBanner, Input, Select, Skeleton, useAlert } from "@aura/ui";
import { LoadingRegion } from "@/components/skeletons";
import {
  bulkTagAction,
  createTagAction,
  fetchTagsAction,
  type BulkActionResult,
  type TagOption,
} from "./actions";

const NEW_TAG = "__new__";

/**
 * Put one tag on every selected contact or deal.
 *
 * Attaching only - taking a tag off in bulk is a different decision ("these
 * are no longer in the campaign") with a different blast radius, and is not
 * what was asked for. Re-tagging a record that already has the tag counts as
 * done, not as an error.
 *
 * A new tag can be named here by an owner or manager (bulk/actions.ts checks
 * it); anyone else picks from the vocabulary that exists.
 */
export function TagDialog({
  open,
  object,
  ids,
  noun,
  onClose,
  onDone,
}: {
  open: boolean;
  object: "contacts" | "deals";
  ids: string[];
  noun: string;
  onClose: () => void;
  onDone: (result: BulkActionResult) => void;
}) {
  const alert = useAlert();
  const [tags, setTags] = useState<TagOption[] | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  // Plain state, not useTransition - see reassign-dialog.tsx.
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchTagsAction().then((result) => {
      if (cancelled) return;
      if (result.error) {
        setLoadError(result.error);
        return;
      }
      setTags(result.tags ?? []);
      setCanCreate(Boolean(result.canCreate));
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setChoice("");
      setNewName("");
    }
  }, [open]);

  const count = ids.length;
  const plural = `${count} ${noun}${count === 1 ? "" : "s"}`;
  const creating = choice === NEW_TAG || (tags?.length === 0 && canCreate);
  const ready = creating ? Boolean(newName.trim()) : Boolean(choice);

  const submit = async () => {
    if (!ready || pending) return;
    setPending(true);
    let tagId = choice;
    if (creating) {
      const created = await createTagAction(newName);
      if (created.error || !created.tag) {
        setPending(false);
        await alert({ title: "Couldn't create the tag", body: created.error ?? "Try again.", tone: "danger" });
        return;
      }
      tagId = created.tag.id;
      // A retry after a failed attach must not try to create the same name again.
      setTags((prev) => [...(prev ?? []), created.tag!]);
      setChoice(created.tag.id);
    }
    const result = await bulkTagAction(object, tagId, ids);
    setPending(false);
    if (result.error) {
      await alert({ title: `Couldn't tag the ${noun}s`, body: result.error, tone: "danger" });
      return;
    }
    onDone(result);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Tag ${plural}`}
      description="Adds the tag; tags already on a record stay."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} loading={pending} disabled={!ready}>
            {`Tag ${plural}`}
          </Button>
        </>
      }
    >
      {loadError ? (
        <ErrorBanner>{loadError}</ErrorBanner>
      ) : tags === null ? (
        <LoadingRegion label="Loading tags" className="space-y-1.5">
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-8" />
          </div>
          <Skeleton className="h-9.5 w-full rounded-sm" />
        </LoadingRegion>
      ) : tags.length === 0 && !canCreate ? (
        <p className="text-sm text-text-muted">
          This workspace has no tags yet. Ask an owner or manager to add the first one.
        </p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {tags.length > 0 ? (
            <div>
              <label htmlFor="bulk-tag-choice" className="text-sm font-medium text-text">
                Tag
              </label>
              <div className="mt-1.5">
                <Select id="bulk-tag-choice" value={choice} onChange={(e) => setChoice(e.target.value)}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  {canCreate ? <option value={NEW_TAG}>+ New tag…</option> : null}
                </Select>
              </div>
            </div>
          ) : null}
          {creating ? (
            <div>
              <label htmlFor="bulk-tag-new" className="text-sm font-medium text-text">
                New tag name
              </label>
              <Input
                id="bulk-tag-new"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={60}
                placeholder="e.g. Diwali campaign"
                autoFocus
                className="mt-1.5"
              />
            </div>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}
