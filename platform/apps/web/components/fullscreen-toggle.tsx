"use client";

import { useCallback, useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { HeaderIconButton } from "@aura/ui";

/**
 * Safari before 16.4 only has the prefixed API, and iPhone Safari has none for
 * a page at all. Typed here rather than widening `Document` globally.
 */
type PrefixedDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type PrefixedElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const fullscreenElement = (d: PrefixedDocument) => d.fullscreenElement ?? d.webkitFullscreenElement ?? null;

/**
 * Focus mode: the console takes the whole monitor, as the browser's F11 does -
 * no tabs, no address bar, no taskbar - through the HTML5 Fullscreen API on the
 * document root, so the sidebar, header and page all come along.
 *
 * ── THE BROWSER OWNS THE EXIT, SO THE ICON LISTENS RATHER THAN REMEMBERS ────
 *
 * Esc, F11 and the browser's own "exit full screen" bar all leave full screen
 * without this component knowing. So `on` is never flipped by the click - it is
 * read back from `fullscreenchange`, which fires for every way in and out. The
 * icon therefore cannot drift into saying "exit" while the browser is already
 * out. (Esc needs no handler of our own: the browser consumes it to exit and
 * then fires that same event.)
 *
 * ── NO LAYOUT SWITCHING NEEDED ──────────────────────────────────────────────
 *
 * The console is already fluid to the viewport: the sidebar is `h-dvh`, the
 * page column is `flex-1` with no max width, and the board sizes its columns
 * from `100dvh`. Full screen simply makes the viewport the monitor, and all of
 * that grows into it. `data-focus-mode` is set on <html> while it is on, for
 * anything that later wants to style differently in focus mode.
 *
 * Hidden where the page cannot go full screen (iPhone Safari, an iframe without
 * `allow="fullscreen"`) - a button that does nothing is worse than no button.
 */
export function FullscreenToggle() {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const d = document as PrefixedDocument;
    setSupported(Boolean(d.fullscreenEnabled ?? d.webkitFullscreenEnabled));
    const sync = () => {
      const active = fullscreenElement(d) !== null;
      setOn(active);
      if (active) document.documentElement.dataset.focusMode = "on";
      else delete document.documentElement.dataset.focusMode;
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  const toggle = useCallback(async () => {
    const d = document as PrefixedDocument;
    try {
      if (fullscreenElement(d)) {
        await (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.());
      } else {
        const root = document.documentElement as PrefixedElement;
        // `navigationUI: "hide"` asks mobile Chrome to drop its bars too.
        await (root.requestFullscreen
          ? root.requestFullscreen({ navigationUI: "hide" })
          : root.webkitRequestFullscreen?.());
      }
    } catch {
      // Refused (a policy, or no user gesture). Nothing changed, and the
      // icon already reflects that because it follows fullscreenchange.
    }
  }, []);

  if (!supported) return null;

  const label = on ? "Exit full screen (Esc)" : "Full screen";
  return (
    <HeaderIconButton onClick={() => void toggle()} aria-label={label} title={label} aria-pressed={on}>
      {on ? (
        <Minimize2 className="h-[18px] w-[18px]" aria-hidden="true" />
      ) : (
        <Maximize2 className="h-[18px] w-[18px]" aria-hidden="true" />
      )}
    </HeaderIconButton>
  );
}
