import { Bot, UserRound } from "lucide-react";
import type { ActivityActor } from "@/lib/activity";

/**
 * Who did it: a person on the team, an automation, or the customer
 * (lib/activity.ts decides which).
 *
 * Three channels at once, never colour: a distinct SHAPE (a dashed ring around
 * a robot for automated, a solid disc with initials for a teammate, a solid
 * disc with a person glyph for the customer), a word ("Automated" / "Customer")
 * and the name. All neutral greys - who acted is not a call state, and the
 * console's four state hues are spent (@aura/ui's state.tsx).
 */
export function ActorAvatar({ actor, size = "md" }: { actor: ActivityActor; size?: "sm" | "md" }) {
  const box = size === "md" ? "h-8 w-8 text-[11px]" : "h-6 w-6 text-[10px]";
  const icon = size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";

  if (actor.kind === "automated") {
    return (
      <span
        aria-hidden="true"
        className={`${box} inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-text-subtle bg-surface text-text-muted`}
      >
        <Bot className={icon} />
      </span>
    );
  }
  if (actor.kind === "contact") {
    return (
      <span
        aria-hidden="true"
        className={`${box} inline-flex shrink-0 items-center justify-center rounded-full bg-surface-hover text-text-muted`}
      >
        <UserRound className={icon} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${box} inline-flex shrink-0 items-center justify-center rounded-full bg-text font-semibold text-bg`}
    >
      {initials(actor.name)}
    </span>
  );
}

/** The word that says which kind, for sighted readers and screen readers alike. */
export function ActorKindLabel({ actor }: { actor: ActivityActor }) {
  if (actor.kind === "human") return <span className="sr-only">By a teammate: </span>;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase ${
        actor.kind === "automated"
          ? "border-dashed border-text-subtle text-text-muted"
          : "border-border bg-surface-hover text-text-muted"
      }`}
    >
      {actor.kind === "automated" ? (
        <>
          <Bot aria-hidden="true" className="h-3 w-3" />
          Automated
        </>
      ) : (
        "Customer"
      )}
    </span>
  );
}

function initials(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}
