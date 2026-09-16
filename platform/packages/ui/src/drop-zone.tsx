"use client";

import { useCallback, useId, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { cx } from "./cx";
import { RowHint } from "./row-hint";

export interface DropZoneProps {
  /** Called with the first accepted file, from a drop OR from the picker. */
  onFile: (file: File) => void;
  /** `accept` for the underlying input, e.g. ".csv". Also filters drops. */
  accept?: string;
  /** The headline inside the zone. */
  label?: string;
  /** What a valid file looks like - shown before anything is chosen. */
  hint?: ReactNode;
  /** The chosen file's name, so the zone can report what it is holding. */
  fileName?: string | null;
  disabled?: boolean;
  className?: string;
}

/**
 * A drop target that teaches itself.
 *
 * ── THE PROBLEM WITH A BARE `<input type="file">` ───────────────────────────
 *
 * It works, and it tells you nothing. It does not say that you can drag onto
 * it (you cannot - a file input is not a drop target for anything but the
 * browser's default navigation), it does not say what shape of file it wants,
 * and after you choose one it reports a truncated filename in a native control
 * that looks like no other control on the page.
 *
 * This is the same one-click affordance plus three things the input cannot do:
 * it accepts a drag, it says so before you try, and it says what it is holding
 * afterwards.
 *
 * ── WHY THE INPUT IS STILL THERE ────────────────────────────────────────────
 *
 * Underneath, unchanged and reachable. Drag-and-drop is not available to a
 * keyboard user, is awkward with a screen reader, and does not exist on the
 * phones a good share of this console is read on. So the zone is a `<label>`
 * wrapping a real file input: click, Enter, Space and tap all open the picker
 * for free, the accessible name comes from the label's own text, and the drag
 * handling is a pure enhancement on top. Nothing here is the only way in.
 */
export function DropZone({
  onFile,
  accept,
  label = "Drop a file here",
  hint,
  fileName,
  disabled = false,
  className = "",
}: DropZoneProps) {
  const [over, setOver] = useState(false);
  const inputId = useId();
  // A drag entering a CHILD element fires dragleave on the parent, so a naive
  // boolean flickers the whole time the pointer moves across the zone's own
  // text. Counting enter/leave pairs is the standard fix.
  const depth = useRef(0);

  const accepts = useCallback(
    (file: File) => {
      if (!accept) return true;
      const patterns = accept.split(",").map((s) => s.trim().toLowerCase());
      const name = file.name.toLowerCase();
      const type = file.type.toLowerCase();
      return patterns.some((p) =>
        p.startsWith(".") ? name.endsWith(p) : p.endsWith("/*") ? type.startsWith(p.slice(0, -1)) : type === p,
      );
    },
    [accept],
  );

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    if (disabled) return;
    const file = Array.from(e.dataTransfer.files).find(accepts);
    if (file) onFile(file);
  };

  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current += 1;
          if (!disabled) setOver(true);
        }}
        onDragOver={(e) => {
          // Without preventDefault on dragOVER - not just dragEnter - the
          // browser keeps its default handling and drop never fires at all.
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = disabled ? "none" : "copy";
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={onDrop}
        className={cx(
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors duration-150 ease-out",
          // Neutral in every state, including the active one. A drop target
          // lighting up green would be a colour meaning "ready", and colour in
          // this console means one of four states (state.tsx) - none of which
          // is "you are hovering". The feedback is a heavier border and a
          // shifted surface, which reads just as clearly and costs nothing
          // from the palette.
          over ? "border-text bg-surface-hover" : "border-border-strong bg-bg-subtle",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <input
          id={inputId}
          type="file"
          accept={accept}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            // Reset, so choosing the SAME file twice fires change twice. After
            // a failed import the natural next move is to fix the file and
            // pick it again, and without this the second pick is silent.
            e.target.value = "";
          }}
        />
        <span className="text-sm font-medium text-text">{label}</span>
        <span className="mt-0.5 text-xs text-text-muted">
          or <span className="underline">browse</span> for one
        </span>
        {fileName ? (
          <span className="mt-2 max-w-full truncate font-mono text-xs text-text">{fileName}</span>
        ) : null}
      </label>
      {hint ? <RowHint kind="dropzone">{hint}</RowHint> : null}
    </div>
  );
}
