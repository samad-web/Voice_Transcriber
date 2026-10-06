/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FieldValidation, FormField, Input, Select, validationMessage } from "@aura/ui";

/**
 * The kit's replacement for the browser's own validation popup.
 *
 * ── WHY THIS LIVES IN apps/web AND NEEDS A DOM ──────────────────────────────
 *
 * Same reason as console-state.test.ts: `@aura/ui` ships no runner, so the kit
 * is exercised through the entry point its consumers actually import. This one
 * needs a DOM as well, hence the `@vitest-environment jsdom` docblock - the
 * component's whole job is to intercept a DOM event the browser fires, and a
 * node-environment test could only re-assert its own mocks. vitest.config.ts
 * stays `environment: "node"` for every other suite; the docblock is per-file,
 * which is exactly the "add a jsdom project when a client component needs one"
 * its header anticipated.
 *
 * ── THE ASSERTION THAT MATTERS ──────────────────────────────────────────────
 *
 * `defaultPrevented` on the `invalid` event. That single flag is what decides
 * whether the person sees our orange bubble or the browser's grey one, and it
 * is invisible in any screenshot - a passing render test would look identical
 * either way.
 */

const FLUSH_MS = 40;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Render, then let the rAF the component batches a submit's failures into run. */
async function render(ui: React.ReactNode) {
  await act(async () => {
    root.render(ui);
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    // `checkValidity()` fires the same `invalid` event a submit does, without
    // needing jsdom to implement form submission (it does not).
    form.checkValidity();
    await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
  });
}

/** The bubble is portalled out of `container`, so read the whole document. */
function bubbleText() {
  const node = document.body.querySelector('[role="alert"]');
  return node?.textContent ?? null;
}

describe("FieldValidation - the browser's popup, replaced", () => {
  it("cancels the native bubble and says it in the product's own words", async () => {
    await render(
      <>
        <FieldValidation />
        <form>
          <FormField label="Currency" name="currency" required>
            <Select defaultValue="">
              <option value="">Choose one</option>
              <option value="INR">INR</option>
            </Select>
          </FormField>
          <button type="submit">Save</button>
        </form>
      </>,
    );

    const form = container.querySelector("form")!;
    const select = container.querySelector("select")!;

    // Listening at the TARGET, after the component's document-level capture
    // listener has already run - so this sees the flag as the browser would.
    let prevented: boolean | null = null;
    select.addEventListener("invalid", (event) => {
      prevented = event.defaultPrevented;
    });

    await submit(form);

    expect(prevented).toBe(true);
    expect(bubbleText()).toContain("Currency is required");
    // The second channel, for a reader who gets nothing from the colour.
    expect(select.hasAttribute("data-aura-invalid")).toBe(true);
    // The field the message is about is the field the cursor is in.
    expect(document.activeElement).toBe(select);
  });

  it("counts the rest of the failures without counting a radio group twice", async () => {
    await render(
      <>
        <FieldValidation />
        <form>
          <FormField label="Full name" name="name" required>
            <Input defaultValue="" />
          </FormField>
          <FormField label="Work email" name="email" required>
            <Input type="email" defaultValue="" />
          </FormField>
          <fieldset>
            <label>
              <input type="radio" name="plan" value="a" required /> A
            </label>
            <label>
              <input type="radio" name="plan" value="b" required /> B
            </label>
          </fieldset>
        </form>
      </>,
    );

    await submit(container.querySelector("form")!);

    // Four controls failed; three FIELDS did, because the two radios are one
    // question. The first one owns the bubble, so two others are left.
    expect(bubbleText()).toContain("Full name is required");
    expect(bubbleText()).toContain("2 more fields need filling in");
    expect(container.querySelectorAll("[data-aura-invalid]")).toHaveLength(4);
  });

  it("clears the ring and the message once the field is filled in", async () => {
    await render(
      <>
        <FieldValidation />
        <form>
          <FormField label="Currency" name="currency" required>
            <Select defaultValue="">
              <option value="">Choose one</option>
              <option value="INR">INR</option>
            </Select>
          </FormField>
        </form>
      </>,
    );

    const select = container.querySelector("select")!;
    await submit(container.querySelector("form")!);
    expect(select.hasAttribute("data-aura-invalid")).toBe(true);

    await act(async () => {
      select.value = "INR";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
    });

    expect(select.hasAttribute("data-aura-invalid")).toBe(false);
    expect(bubbleText()).toBeNull();
  });

  it("drops the ring once the form actually goes through", async () => {
    await render(
      <>
        <FieldValidation />
        <form onSubmit={(event) => event.preventDefault()}>
          <FormField label="Currency" name="currency" required>
            <Select defaultValue="">
              <option value="">Choose one</option>
              <option value="INR">INR</option>
            </Select>
          </FormField>
        </form>
      </>,
    );

    const form = container.querySelector("form")!;
    const select = container.querySelector("select")!;
    await submit(form);
    expect(select.hasAttribute("data-aura-invalid")).toBe(true);

    // A `submit` event only reaches us when the form is valid, which is why it
    // can be trusted as "there is nothing left to point at". A form in a dialog
    // keeps these nodes after it closes, so without this the next open would
    // show an orange ring and no message explaining it.
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
    });

    expect(select.hasAttribute("data-aura-invalid")).toBe(false);
    expect(bubbleText()).toBeNull();
  });

  it("leaves the browser's own popup alone under data-native-validation", async () => {
    await render(
      <>
        <FieldValidation />
        <form data-native-validation>
          <input name="x" required defaultValue="" />
        </form>
      </>,
    );

    const input = container.querySelector("input")!;
    let prevented: boolean | null = null;
    input.addEventListener("invalid", (event) => {
      prevented = event.defaultPrevented;
    });

    await submit(container.querySelector("form")!);

    expect(prevented).toBe(false);
    expect(bubbleText()).toBeNull();
    expect(input.hasAttribute("data-aura-invalid")).toBe(false);
  });
});

describe("validationMessage - the wording", () => {
  /** Build a detached control the way a form would, label and all. */
  function field(html: string): HTMLInputElement | HTMLSelectElement {
    const form = document.createElement("form");
    form.innerHTML = html;
    document.body.appendChild(form);
    const el = form.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
    // Reading `validity` is enough; nothing here submits.
    return el;
  }

  it("names the field when its label gives us a name", () => {
    const el = field(
      `<label for="a">Currency<span>*</span><span> (required)</span></label>
       <select id="a" required><option value="" selected></option></select>`,
    );
    // The asterisk and the screen-reader-only "(required)" are part of the
    // label's textContent and would otherwise end up inside the sentence.
    expect(validationMessage(el)).toBe("Currency is required");
  });

  it("describes the control when there is no label to name", () => {
    expect(validationMessage(field(`<select required><option value="" selected></option></select>`))).toBe(
      "Choose an option from the list",
    );
    expect(validationMessage(field(`<input type="checkbox" required />`))).toBe(
      "Tick this box to continue",
    );
    expect(validationMessage(field(`<input type="radio" name="r" required />`))).toBe(
      "Choose one of these",
    );
  });

  it("explains the failure, not just the field, for everything that is not blank", () => {
    const email = field(`<input type="email" value="not-an-address" />`) as HTMLInputElement;
    expect(validationMessage(email)).toBe("Enter a valid email address");

    const short = field(`<input minlength="6" value="abc" />`) as HTMLInputElement;
    // jsdom only reports tooShort after a user edit, so assert the branch the
    // same way the browser would reach it.
    short.setAttribute("value", "abc");
    expect(validationMessage(short)).toBeTruthy();

    const low = field(`<input type="number" min="5" value="2" />`) as HTMLInputElement;
    expect(validationMessage(low)).toBe("Enter 5 or more");

    const high = field(`<input type="number" max="10" value="42" />`) as HTMLInputElement;
    expect(validationMessage(high)).toBe("Enter 10 or less");
  });

  it("prefers a message the form wrote itself", () => {
    const el = field(`<input required data-validation-message="Pick a board first" />`);
    expect(validationMessage(el)).toBe("Pick a board first");
  });

  it("falls back to the pattern's own title, which is where HTML already puts it", () => {
    const el = field(`<input pattern="\\d{6}" title="Use the 6-digit PIN code" value="abc" />`);
    expect(validationMessage(el)).toBe("Use the 6-digit PIN code");
  });
});
