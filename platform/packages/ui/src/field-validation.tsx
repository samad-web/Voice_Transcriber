"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { STATE_TONE } from "./state";

/**
 * The browser's own validation popup, replaced with ours.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * Every `<form>` in the console that carries a `required` field and does not
 * set `noValidate` hands its failure message to the BROWSER, which draws a
 * grey-on-white box in the OS font with an orange "!" disc and wording nobody
 * here wrote - "Please select an item in the list.", "Please fill out this
 * field." It ignores the theme (it is white over a dark console), it ignores
 * the type scale, it cannot be read by a screen reader on every engine, it
 * disappears on the next click, and it looks like a different product. Three
 * engines, three different boxes, none of them ours.
 *
 * Rewriting twenty-odd forms to validate in React was the alternative. This is
 * one listener instead, and it covers forms nobody has written yet.
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────────
 *
 * The `invalid` event fires on each failing control when a form is submitted
 * (and only then - no keystroke-by-keystroke nagging, which is the behaviour
 * the native flow already gets right). It is CANCELABLE: `preventDefault()`
 * suppresses the browser's bubble and nothing else. The submit stays blocked,
 * because what blocks it is the form being invalid, not the popup. So we
 * cancel the popup and draw our own in its place.
 *
 * It does not bubble, hence the capture-phase listener on `document` - the one
 * place that sees it for every form in the app, including forms rendered into
 * a `<dialog>`.
 *
 * ── WHY ORANGE AND NOT RED ──────────────────────────────────────────────────
 *
 * Red means MISSED in this console (state.tsx). A field you have not filled in
 * yet is an error, and errors are orange - the same `STATE_TONE.error` tone,
 * triangle glyph included, that `ErrorBanner` and an "Error" chip already use.
 * The colour is never the only channel: there is the triangle, the words, and
 * the ring on the control itself.
 *
 * ── OPTING OUT ──────────────────────────────────────────────────────────────
 *
 * `data-native-validation` on a form (or any ancestor) leaves the browser's own
 * bubble alone. Nothing uses it; it exists so a future embed that genuinely
 * needs the native behaviour has a door.
 *
 * `data-validation-message` on a control overrides the generated wording.
 * `data-field-label` overrides the name we read off its `<label>`.
 */

type Validatable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Set on the control (or its nearest visible ancestor) while it is failing. */
const INVALID_ATTR = "data-aura-invalid";

/** Gap between the control's edge and the bubble, in px. */
const GAP = 8;

/** Distance the bubble keeps from the viewport edge, in px. */
const EDGE = 8;

/** How long the bubble stays before it clears itself. */
const DISMISS_MS = 10_000;

/** Below this, a control has no box worth pointing at - an `sr-only` radio. */
const MIN_ANCHOR = 8;

function isValidatable(node: EventTarget | null): node is Validatable {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLSelectElement ||
    node instanceof HTMLTextAreaElement
  );
}

/**
 * The field's name, in the words the person just read.
 *
 * `labels[0]` rather than a `querySelector` on `for`: it already resolves both
 * the `for=` association and the wrapping-`<label>` one, which is the form the
 * marketing app's time-slot radios use.
 */
function labelFor(el: Validatable): string | null {
  const override = el.getAttribute("data-field-label");
  if (override) return override.trim();

  const labels = el.labels;
  const raw =
    (labels && labels.length > 0 ? labels[0].textContent : null) ??
    el.getAttribute("aria-label") ??
    el.getAttribute("placeholder");
  if (!raw) return null;

  const clean = raw
    .replace(/\s+/g, " ")
    // `Label` renders `Currency` + `*` + an sr-only ` (required)`, so the
    // textContent of a required field's label ends with both. Neither belongs
    // in a sentence that is itself the required message.
    .replace(/\((?:required|optional)\)/gi, "")
    .replace(/[*✱]/g, "")
    .replace(/[:·-]\s*$/, "")
    .trim();

  // A long one is a paragraph, not a name - a checkbox whose label is a whole
  // consent sentence. Those fall through to the generic wording below.
  return clean.length > 0 && clean.length <= 48 ? clean : null;
}

/** "3" for `step="3"`, null for "any" or an unparseable one. */
function numeric(value: string | null): string | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? value : null;
}

/**
 * What went wrong, in this product's voice.
 *
 * House style is `"Currency is required"` (it is already the copy on the
 * business form), so a field we can name says that, and only a field we cannot
 * name falls back to wording that describes the control instead.
 */
export function validationMessage(el: Validatable): string {
  const override = el.getAttribute("data-validation-message");
  if (override) return override;

  const v = el.validity;
  const name = labelFor(el);
  const type = (el.getAttribute("type") ?? "").toLowerCase();

  if (v.valueMissing) {
    if (name) return `${name} is required`;
    if (el instanceof HTMLSelectElement) return "Choose an option from the list";
    if (type === "checkbox") return "Tick this box to continue";
    if (type === "radio") return "Choose one of these";
    if (type === "file") return "Add a file to continue";
    return "This field is required";
  }

  if (v.typeMismatch) {
    if (type === "email") return "Enter a valid email address";
    if (type === "url") return "Enter a link that starts with https://";
    if (type === "tel") return "Enter a valid phone number";
    return name ? `${name} is not valid` : "Enter a valid value";
  }

  if (v.patternMismatch) {
    // `title` is where HTML already expects the author's explanation of a
    // pattern, and the browser appends it to its own message for the same
    // reason. If a form bothered to write one, it is better than ours.
    const title = el.title.trim();
    if (title) return title;
    return name ? `${name} is not in the expected format` : "That is not in the expected format";
  }

  if (v.tooShort) {
    const min = (el as HTMLInputElement).minLength;
    return min > 0 ? `Use at least ${min} characters` : "That is too short";
  }

  if (v.tooLong) {
    const max = (el as HTMLInputElement).maxLength;
    return max > 0 ? `Use at most ${max} characters` : "That is too long";
  }

  if (v.rangeUnderflow) {
    const min = numeric(el.getAttribute("min"));
    return min ? `Enter ${min} or more` : "That is too low";
  }

  if (v.rangeOverflow) {
    const max = numeric(el.getAttribute("max"));
    return max ? `Enter ${max} or less` : "That is too high";
  }

  if (v.stepMismatch) {
    const step = numeric(el.getAttribute("step"));
    return step ? `Enter a multiple of ${step}` : "Enter a valid value";
  }

  if (v.badInput) {
    if (type === "number") return "Enter a number";
    if (type === "date" || type === "datetime-local") return "Enter a valid date";
    if (type === "time") return "Enter a valid time";
    return "Enter a valid value";
  }

  // `customError` is set by a call site's own setCustomValidity - that message
  // was written here, so it is already in our voice. Same for anything a future
  // engine adds that we have no branch for: the native string beats nothing.
  return el.validationMessage || "Check this field";
}

/**
 * Where to draw the ring and point the bubble.
 *
 * Usually the control itself. Not for a visually hidden one - the marketing
 * app's time slots are `sr-only` radios inside a styled `<label>`, and a ring
 * on a 1px clipped box is a ring nobody sees. Walk up to the first ancestor
 * that actually occupies space, stopping at the form so a failure never
 * highlights the whole page.
 */
function anchorFor(el: Validatable): HTMLElement {
  const own = el.getBoundingClientRect();
  if (own.width >= MIN_ANCHOR && own.height >= MIN_ANCHOR) return el;

  let node: HTMLElement | null = el.parentElement;
  while (node && node !== el.form && node.tagName !== "BODY") {
    const rect = node.getBoundingClientRect();
    if (rect.width >= MIN_ANCHOR && rect.height >= MIN_ANCHOR) return node;
    node = node.parentElement;
  }
  return el;
}

interface Shown {
  /** The control that failed - the one we focus and watch for a correction. */
  control: Validatable;
  /** The box we point at and ring. Equal to `control` unless it is hidden. */
  anchor: HTMLElement;
  message: string;
  /** How many OTHER fields failed in the same submit. */
  others: number;
}

interface Placement {
  top: number;
  left: number;
  /** Which side of the control the bubble ended up on - the arrow follows. */
  side: "above" | "below";
  /** The arrow's offset from the bubble's left edge. */
  arrow: number;
}

/**
 * Mount once per app. `FeedbackProvider` already does it, so the console gets
 * this for free; the marketing app mounts it directly in its layout.
 *
 * Renders nothing until a form fails.
 */
export function FieldValidation() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);

  const bubble = useRef<HTMLDivElement | null>(null);
  /** Control → the element we put the ring on, for this round of failures. */
  const marks = useRef(new Map<Validatable, HTMLElement>());
  /** Controls collected from one submit, flushed together on the next frame. */
  const batch = useRef<Validatable[]>([]);
  const frame = useRef<number | null>(null);

  /** Drop every ring and the bubble. */
  const reset = useCallback(() => {
    for (const anchor of marks.current.values()) anchor.removeAttribute(INVALID_ATTR);
    marks.current.clear();
    setShown(null);
  }, []);

  // ── collecting a submit's failures ─────────────────────────────────────────
  useEffect(() => {
    const flush = () => {
      frame.current = null;
      const failed = batch.current;
      batch.current = [];
      if (failed.length === 0) return;

      for (const anchor of marks.current.values()) anchor.removeAttribute(INVALID_ATTR);
      marks.current.clear();

      for (const control of failed) {
        const anchor = anchorFor(control);
        anchor.setAttribute(INVALID_ATTR, "");
        marks.current.set(control, anchor);
      }

      const [first] = failed;
      const anchor = marks.current.get(first) ?? first;

      // preventScroll, then centre it ourselves: the browser's own focus scroll
      // puts the field flush against the top edge of the scroller, which is
      // exactly where the bubble would have no room to open downwards.
      try {
        first.focus({ preventScroll: true });
      } catch {
        first.focus();
      }
      // Both optional: `scrollIntoView` and `matchMedia` are the two DOM APIs
      // jsdom does not implement, and a test harness is not a reason for the
      // whole flush to throw halfway through and leave the rings on with no
      // message beside them.
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      anchor.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });

      // A radio group fires `invalid` once per radio. They are one field to the
      // person filling the form, so they count once in "2 more to fill in".
      const fields = new Set(
        failed.map((el) =>
          el instanceof HTMLInputElement && el.type === "radio" ? `radio:${el.name}` : el,
        ),
      );

      setShown({
        control: first,
        anchor,
        message: validationMessage(first),
        others: Math.max(0, fields.size - 1),
      });
    };

    const onInvalid = (event: Event) => {
      const el = event.target;
      if (!isValidatable(el)) return;
      if (el.closest("[data-native-validation]")) return;

      // The whole trick: this kills the browser's bubble and nothing else. The
      // form stays unsubmitted because it is invalid, not because of the popup.
      event.preventDefault();

      batch.current.push(el);
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    };

    document.addEventListener("invalid", onInvalid, true);
    return () => {
      document.removeEventListener("invalid", onInvalid, true);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  // ── clearing it again ──────────────────────────────────────────────────────
  useEffect(() => {
    const onEdit = (event: Event) => {
      const el = event.target;
      if (!isValidatable(el)) return;
      const anchor = marks.current.get(el);
      if (!anchor) return;

      // `el.validity.valid`, never `checkValidity()` - the method DISPATCHES an
      // `invalid` event when it fails, which would land straight back in the
      // listener above and re-open the bubble on every keystroke.
      if (el.validity.valid) {
        anchor.removeAttribute(INVALID_ATTR);
        marks.current.delete(el);
      }
      // Either way the bubble goes: they are dealing with this field now, and a
      // message sitting under a field being typed into is just in the way.
      setShown((current) => (current && current.control === el ? null : current));
    };

    /** Clicking anywhere else means they have moved on. */
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      setShown((current) => {
        if (!current) return current;
        if (current.anchor.contains(target)) return current;
        if (bubble.current?.contains(target)) return current;
        return null;
      });
    };

    const onFocusOut = (event: Event) => {
      const el = (event as FocusEvent).target;
      setShown((current) => (current && current.control === el ? null : current));
    };

    /**
     * The form went through, or was reset. A `submit` event only fires once the
     * form is VALID, so this is the signal that there is nothing left to point
     * at - and it is the one that matters for a form inside a dialog, which
     * keeps its DOM nodes after it closes and would otherwise re-open with
     * yesterday's orange ring still on it.
     */
    const onSettled = (event: Event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      for (const [control, anchor] of marks.current) {
        if (control.form === form) {
          anchor.removeAttribute(INVALID_ATTR);
          marks.current.delete(control);
        }
      }
      setShown((current) => (current && current.control.form === form ? null : current));
    };

    document.addEventListener("input", onEdit, true);
    document.addEventListener("change", onEdit, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("submit", onSettled, true);
    document.addEventListener("reset", onSettled, true);
    return () => {
      document.removeEventListener("input", onEdit, true);
      document.removeEventListener("change", onEdit, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("submit", onSettled, true);
      document.removeEventListener("reset", onSettled, true);
    };
  }, []);

  // A message with no expiry is one that outlives the thing it was about - the
  // dialog closes, the row is saved, and a stale orange box is still floating.
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), DISMISS_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  // ── the portal host ────────────────────────────────────────────────────────
  //
  // A `<dialog>` opened with showModal() renders in the browser's TOP LAYER,
  // which is above every z-index on the page: a bubble appended to <body> would
  // be drawn behind the dialog and the person would see nothing at all. So the
  // host goes inside the dialog when the field is in one.
  //
  // The host is a div we create and append ourselves rather than a portal
  // straight into the dialog, so React is never reconciling children it did not
  // render against a node it did.
  useEffect(() => {
    if (!shown) {
      setHost(null);
      return;
    }
    const parent = shown.anchor.closest("dialog[open]") ?? document.body;
    const node = document.createElement("div");
    node.setAttribute("data-aura-validation-host", "");
    parent.appendChild(node);
    setHost(node);
    return () => {
      node.remove();
      setHost(null);
    };
  }, [shown]);

  // Ring and bubble both go when the component does - a route change mid-error
  // would otherwise leave an orange control behind with nothing explaining it.
  useEffect(() => reset, [reset]);

  // ── positioning ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!shown || !host) {
      setPlace(null);
      return;
    }

    const position = () => {
      // The field can go away under us: a dialog closes, a list re-renders.
      if (!shown.anchor.isConnected) {
        setShown(null);
        return;
      }
      const rect = shown.anchor.getBoundingClientRect();
      const box = bubble.current?.getBoundingClientRect();
      const height = box?.height ?? 40;
      const width = box?.width ?? 260;

      const fitsBelow = rect.bottom + GAP + height <= window.innerHeight - EDGE;
      const top = fitsBelow ? rect.bottom + GAP : rect.top - GAP - height;
      const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE));

      // The arrow tracks the control, not the bubble, so a bubble pushed off
      // the viewport edge still points at the field it belongs to.
      const tip = rect.left + Math.min(rect.width / 2, 24);
      const arrow = Math.max(10, Math.min(tip - left, width - 18));

      setPlace({ top, left, side: fitsBelow ? "below" : "above", arrow });
    };

    position();
    // Capture, so a scroll inside a dialog body or a table wrapper counts too -
    // a scroll event on an inner element does not reach window any other way.
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [shown, host]);

  if (!shown || !host) return null;

  const tone = STATE_TONE.error;

  return createPortal(
    <div
      ref={bubble}
      // role="alert" so it is announced the moment it appears, which is the
      // half of the native bubble that several screen readers never did.
      role="alert"
      // Never intercepts a click: the control it points at is right underneath,
      // and a message that swallows the click fixing it is worse than no
      // message. Dismissal is handled by the listeners above instead.
      className={cx(
        "pointer-events-none fixed z-50 flex max-w-72 items-start gap-2 rounded-md border px-3 py-2",
        "text-xs font-medium shadow-lg transition-opacity duration-150 ease-out",
        // Straight from STATE_TONE, so this and an "Error" chip can never end
        // up two different oranges.
        tone.chip,
        place ? "opacity-100" : "opacity-0",
      )}
      style={{ top: place?.top ?? -9999, left: place?.left ?? -9999 }}
    >
      {/* The warning triangle, same silhouette as ErrorBanner's. In greyscale
          or for a reader who cannot separate orange from the surface, the shape
          is what says "problem". */}
      <svg aria-hidden="true" viewBox="0 0 10 10" className="mt-0.5 h-3 w-3 shrink-0">
        {tone.glyph}
      </svg>
      <span className="min-w-0">
        {shown.message}
        {shown.others > 0 ? (
          <span className="mt-0.5 block font-normal opacity-80">
            {shown.others === 1 ? "1 more field needs filling in" : `${shown.others} more fields need filling in`}
          </span>
        ) : null}
      </span>
      {place ? (
        <span
          aria-hidden="true"
          className={cx(
            "absolute h-2 w-2 rotate-45 border",
            // Same tone string as the bubble, so the arrow cannot drift to a
            // second orange if the error tone is ever retuned.
            tone.chip,
            // Only the two edges facing outward carry the border, so the arrow
            // reads as a continuation of the bubble's outline rather than a
            // diamond stuck to its side.
            place.side === "below"
              ? "-top-[4.5px] border-r-0 border-b-0"
              : "-bottom-[4.5px] border-t-0 border-l-0",
          )}
          style={{ left: place.arrow }}
        />
      ) : null}
    </div>,
    host,
  );
}
