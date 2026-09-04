"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Fullscreen for one element.
 *
 * Two things bite here, and both are the reason this is a hook rather than a
 * two-line click handler:
 *
 *  - **The state has to come from the event, not the click.** A person can
 *    leave fullscreen with Escape or the browser's own control, which no
 *    handler of ours ever sees. Tracking it from `fullscreenchange` is what
 *    keeps the button's label honest.
 *  - **`requestFullscreen()` can be a silent no-op.** Some embedded webviews
 *    disallow it and reject nothing - the button simply appears broken.
 *    `document.fullscreenEnabled` is the only advance warning available, so
 *    callers can disable the control and say why instead.
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(document.fullscreenEnabled !== false);
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void ref.current?.requestFullscreen();
  }, [ref]);

  return { isFullscreen, supported, toggle };
}
