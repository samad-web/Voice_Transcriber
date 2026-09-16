"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeChannelFor, type MessagingChannel } from "@/lib/nav";

/**
 * The messaging stack's second-level navigation.
 *
 * ── LINKS, NOT TABS ─────────────────────────────────────────────────────────
 *
 * These look like the tab strips elsewhere in the console and are deliberately
 * NOT `role="tablist"`. Each channel is a separate route with its own server
 * data; a real tab panel is content already in the document that a click
 * reveals. Announcing five links as tabs would promise a screen-reader user
 * that arrow keys move between panels instantly, when what actually happens is
 * a navigation. `<nav>` + `aria-current="page"` says the true thing, and gets
 * back-button behaviour, middle-click-to-open-in-a-tab and prefetch for free -
 * all of which a tablist would have thrown away.
 *
 * ── WHY THE ACTIVE ONE IS NOT COLOURED ──────────────────────────────────────
 *
 * The rail's active item carries the brand gradient. This strip's does not: it
 * gets a 2px underline and full-contrast text against muted, exactly like the
 * instance page's strip. Two gradient fills on one screen, one inside the
 * other, stops reading as "you are here" and starts reading as decoration -
 * and the strip sits directly under a PageHeader that already carries the
 * brand wash. The rule from state.tsx applies here too: "which tab is
 * selected" is not one of the four states, so it does not get a hue.
 */
export function ChannelSwitcher({ channels }: { channels: MessagingChannel[] }) {
  const pathname = usePathname();
  const active = activeChannelFor(pathname, channels);

  // One channel is not a choice, and nought is not a strip. Both render
  // nothing rather than a lone highlighted pill that cannot be clicked off -
  // see messagingChannelsFor's note on why either can happen.
  if (channels.length < 2) return null;

  return (
    <div className="print-hide">
      <nav
        aria-label="Messaging channels"
        className="-mx-4 overflow-x-auto border-b border-border px-4 sm:-mx-5 sm:px-5 md:-mx-8 md:px-8"
      >
        <ul className="-mb-px flex gap-0.5">
          {channels.map((channel) => {
            const on = channel === active;
            return (
              <li key={channel.key}>
                <Link
                  href={channel.href}
                  aria-current={on ? "page" : undefined}
                  className={
                    // The strip scrolls horizontally, which clips the block
                    // axis too - theme.css's focus ring sits 2px outside the
                    // element and would be cropped. Drawn inside instead.
                    "flex h-11 shrink-0 items-center rounded-t-md border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out focus-visible:-outline-offset-2 sm:px-4 " +
                    (on
                      ? "border-text text-text"
                      : "border-transparent text-text-muted hover:text-text")
                  }
                >
                  {channel.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {active ? (
        // The blurb is the self-teaching half of the switcher. A person who
        // has just landed on "WABA" from a rail item called "WhatsApp Setup"
        // needs one sentence telling them they are in the right place, and the
        // sentence changes with the tab rather than being a static paragraph
        // each page repeats in its own words.
        <p className="mt-2 text-xs text-text-muted">{active.blurb}</p>
      ) : null}
    </div>
  );
}
