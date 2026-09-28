"use client";

/**
 * An on/off switch, drawn the way the Features board draws its switches
 * (features/feature-board.tsx) so the console has one switch, not two. A real
 * `role="switch"` button, so a screen reader announces "on"/"off" rather than
 * a checkbox's "checked".
 *
 * Grey when on, not green: the colour rule reserves green for a conversation
 * that happened, and a setting being on is not a state in that sense.
 */
export function Toggle({
  on,
  label,
  disabled = false,
  onChange,
}: {
  on: boolean;
  /** The accessible name - what is being switched. */
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-150 ${
        on ? "border-border-strong bg-text" : "border-border-strong bg-bg-subtle"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 h-4.5 w-4.5 rounded-full transition-all duration-150 ${
          on ? "left-[1.375rem] bg-surface" : "left-0.5 bg-text-subtle"
        }`}
      />
    </button>
  );
}
