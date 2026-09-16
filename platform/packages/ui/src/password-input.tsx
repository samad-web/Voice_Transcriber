"use client";

import { useState } from "react";
import { cx } from "./cx";
import { Input, type InputProps } from "./input";

/**
 * `Input` for a password, with a show/hide toggle.
 *
 * Takes every prop `Input` does and forwards them to the real `<input>` -
 * including the `id`, `name`, `aria-*` and `invalid` that `FormField` clones in -
 * so it drops into `<FormField>` exactly where an `Input` would. Wrapping an
 * `Input` in a `<div>` by hand does NOT: FormField would clone the div and the
 * field would submit with no `name`.
 */
export function PasswordInput({ className = "", disabled, ...rest }: InputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        {...rest}
        disabled={disabled}
        type={visible ? "text" : "password"}
        // `pr-10` keeps typed text clear of the toggle. `::-ms-reveal` is Edge's
        // own built-in eye, which would otherwise sit beside this one.
        className={cx("pr-10 [&::-ms-reveal]:hidden", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={rest.id}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-sm text-text-muted transition-colors duration-150 ease-out hover:text-text disabled:cursor-not-allowed disabled:text-text-subtle"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          {visible ? (
            <>
              <path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.54 3.42" />
              <path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6" />
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
              <path d="M2 2l20 20" />
            </>
          ) : (
            <>
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}
