"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Pause, Play } from "lucide-react";
import { claimPlayback, releasePlayback } from "@/lib/audio-playback";

/**
 * A call recording, playable from inside a table row.
 *
 * ── WHY IT LIVES IN THE ROW AT ALL ──────────────────────────────────────────
 *
 * Hearing thirty seconds of a call is how a manager triages a log: was this
 * lead real, did the rep say the disclosure, is the AI read right. Before this,
 * that cost a drawer open, a "Load audio" press and a close, per row - so in
 * practice nobody sampled a log, they read summaries and trusted them.
 *
 * ── WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────────
 *
 * Not a second full player. Scrubbing a six-minute call across 70 pixels is
 * three and a half seconds per pixel, which is not a control, so the row offers
 * play/pause, a progress track and one clock; the drawer keeps the full-size
 * native player for anyone who needs to work through a conversation properly.
 * The track is still a real `<input type="range">` rather than a painted bar,
 * because arrow-key seeking costs nothing here and a mouse-only scrubber would
 * be a control a keyboard user can see and not use.
 *
 * ── THE THREE THINGS THAT KEEP A 50-ROW PAGE FAST ───────────────────────────
 *
 * 1. No `<audio>` element exists until the first press. Fifty elements at
 *    `preload="metadata"` is fifty range requests against storage on render,
 *    for a page where the reader will play at most one.
 * 2. No signed URL is fetched until the first press either - and never on
 *    hover. Every URL costs a round trip AND writes a `recording.playback`
 *    audit row; prefetching would fill a customer's audit trail with listens
 *    that never happened, which is worse than slow.
 * 3. Progress is this component's own state. The row, the table and the page
 *    never re-render while a recording plays - `timeupdate` fires about four
 *    times a second and it stops at this leaf.
 *
 * ── LAYOUT ──────────────────────────────────────────────────────────────────
 *
 * Fixed width, and the track is rendered (disabled) even at rest. A cell that
 * grew when you pressed play would reflow every column to its right, on a table
 * the reader is in the middle of scanning.
 */

/** "0:07", "12:41" - the clock a media player uses, not the log's "1m". */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

type Phase = "idle" | "loading" | "ready" | "error";

export interface InlineRecordingPlayerProps {
  callId: string;
  /**
   * Who the call was with, woven into the control's accessible name. An icon
   * button reading "Play" fifty times down a page tells a screen-reader user
   * nothing about which call they are about to play.
   */
  label: string;
  /** The row's own `duration_s`, shown at rest so the cell says something before any fetch. */
  durationS: number;
  /**
   * Mints a short-lived signed URL for this call. Injected rather than imported
   * because the two call logs reach the same recording through different doors:
   * the client console's Server Action carries the member's session and is
   * refused without their `recordings_listen` grant, while the operator
   * console's carries the platform key and answers to the tenant's call-access
   * gate (0122). Each tier keeps its own authorisation; this component knows
   * neither.
   */
  fetchUrl: (callId: string) => Promise<{ url?: string; error?: string }>;
}

export function InlineRecordingPlayer({
  callId,
  label,
  durationS,
  fetchUrl,
}: InlineRecordingPlayerProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  /**
   * Waiting for bytes - either the first ones after a press, or a mid-stream
   * stall. Its own flag rather than folded into `phase` because the row is
   * genuinely playing while it stalls: the pause icon and the progress track
   * stay, and only the button's glyph becomes the spinner. Without it, the gap
   * between pressing play on a cold object and the first audible sound showed a
   * play arrow, which reads as "the press did nothing".
   */
  const [buffering, setBuffering] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  /** The element's own duration once known - a row's `duration_s` is rounded. */
  const [measured, setMeasured] = useState<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Where to pick up after a re-signed URL remounts the element. */
  const resumeAtRef = useRef(0);
  /**
   * The position the last silent re-sign was made from, or -1 for none. A
   * re-sign is only allowed from strictly further into the call than the last
   * one: several expiries in a long listen are legitimate, but a source that
   * errors at the same second forever must not re-sign forever.
   */
  const reSignedAtRef = useRef(-1);
  /** Set when a fetch was started by a press, so the src arriving starts playback. */
  const autoStartRef = useRef(false);

  // A detached media element keeps playing, so pagination - which unmounts
  // every player at once - has to stop this one rather than only forgetting it.
  // The events do not help here: once React has removed the node they no longer
  // reach the handlers below.
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      if (!el) return;
      el.pause();
      releasePlayback(el);
    };
  }, [src]);

  /**
   * Begin playback on a freshly-mounted element - called from
   * `loadedmetadata`, not from the press.
   *
   * The press cannot do it: the element it was for does not exist yet, because
   * the signed URL has to be fetched first. And `loadedmetadata` specifically,
   * rather than as soon as the src is set, because a resumed listen has to seek
   * BEFORE it plays - `currentTime` cannot be set on an element that does not
   * know its own duration yet, so playing first would give an audible replay of
   * the opening seconds every time a signature was renewed mid-call.
   *
   * Chrome and Firefox allow this `play()` on the page's sticky activation even
   * though a fetch has happened since the click. Safari may refuse, and the
   * catch is what that costs: the row settles into a loaded, paused state, and
   * the second press - a direct gesture, with the source already there - starts
   * it immediately.
   */
  function startPlayback(el: HTMLAudioElement) {
    claimPlayback(el);
    setBuffering(true);
    void el.play().catch(() => {
      setPlaying(false);
      setBuffering(false);
    });
  }

  async function signAndPlay(resumeAt: number) {
    resumeAtRef.current = resumeAt;
    autoStartRef.current = true;
    setProblem(null);
    setPhase("loading");
    const result = await fetchUrl(callId);
    if (result.error || !result.url) {
      autoStartRef.current = false;
      setProblem(result.error ?? "No recording stored for this call.");
      setPhase("error");
      return;
    }
    setSrc(result.url);
    setPhase("ready");
  }

  function toggle() {
    // A failed element is not worth pressing play on again - the source behind
    // it is what failed. Drop it and sign a fresh one from the top.
    if (phase === "error") {
      setSrc(null);
      setElapsed(0);
      setMeasured(null);
      reSignedAtRef.current = -1;
      void signAndPlay(0);
      return;
    }
    const el = audioRef.current;
    if (el && src) {
      // `startPlayback` claims the slot before `play()` resolves on purpose:
      // until it does, the row that was playing is still making sound.
      if (el.paused) startPlayback(el);
      else el.pause();
      return;
    }
    void signAndPlay(0);
  }

  /**
   * A signed URL outlives the click but not necessarily the call. When the
   * element errors after it had been playing, the overwhelmingly likely cause
   * is the signature expiring mid-stream, so the row re-signs itself and
   * resumes from the same second rather than showing the reader a fault they
   * did not cause and cannot act on.
   *
   * Allowed more than once, because a long listen can outlive two signatures -
   * but only from further in than the last recovery, which is what stops a
   * genuinely broken object from re-signing in a loop.
   */
  function onError() {
    const el = audioRef.current;
    const at = el?.currentTime ?? 0;
    setBuffering(false);
    if (at <= 0 || at <= reSignedAtRef.current) {
      setPlaying(false);
      setProblem(problem ?? "This recording could not be played.");
      setPhase("error");
      return;
    }
    reSignedAtRef.current = at;
    void signAndPlay(at);
  }

  const total = measured ?? (durationS > 0 ? durationS : 0);
  const atRest = phase === "idle" || phase === "loading";
  const percent = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
  const seekable = phase === "ready" && total > 0;

  return (
    // The row underneath opens the call's drawer. Everything in this cell is a
    // different action, and a press must never do both - the same guard the
    // lead link in this table already uses, extended to keys because the play
    // button answers to Space and so does the row.
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="flex w-[170px] items-center gap-2"
    >
      <button
        type="button"
        onClick={toggle}
        disabled={phase === "loading"}
        // The name says what the press does AND which call it does it to.
        aria-label={`${playing ? "Pause" : "Play"} the recording of ${label}`}
        title={problem ?? undefined}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-text-muted transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-hover hover:text-text disabled:cursor-default disabled:opacity-60"
      >
        {phase === "loading" || buffering ? (
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
        ) : phase === "error" ? (
          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 text-danger" />
        ) : playing ? (
          <Pause aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
        ) : (
          <Play aria-hidden="true" className="h-3.5 w-3.5" />
        )}
      </button>

      {phase === "error" ? (
        // In the cell, not a toast: the reader pressed play on THIS row and the
        // answer belongs where they are looking. Two lines rather than one
        // truncated one - "Your account cannot pl…" is a sentence the reader
        // has to hover to finish, and both these rows are already two lines
        // tall, so the wrap costs nothing. The full text stays on the title for
        // the rare message longer than that.
        <span
          className="line-clamp-2 text-xs leading-tight text-danger-text"
          title={problem ?? undefined}
        >
          {problem ?? "Could not play"}
        </span>
      ) : (
        <>
          <input
            type="range"
            min={0}
            max={total > 0 ? total : 1}
            step={0.5}
            value={Math.min(elapsed, total)}
            disabled={!seekable}
            onChange={(e) => {
              const el = audioRef.current;
              const next = Number(e.target.value);
              if (el) el.currentTime = next;
              setElapsed(next);
            }}
            aria-label={`Seek within the recording of ${label}`}
            // The visible clock shows one number to fit the cell; a screen
            // reader gets the pair, which is what "where am I" actually needs.
            aria-valuetext={`${clock(elapsed)} of ${clock(total)}`}
            // The filled part of the track is painted with a gradient rather
            // than a second element: `::-webkit-slider-runnable-track` and
            // Firefox's `::-moz-range-progress` disagree about everything else,
            // and a background works identically in both.
            style={{
              backgroundImage: `linear-gradient(to right, var(--color-accent) ${percent}%, var(--color-border) ${percent}%)`,
            }}
            // The thumb is hidden while the track is disabled. A grab handle on
            // a control that cannot be grabbed is the one thing this cell must
            // not show: at rest the track is a shape saying "there is audio
            // here", and the handle appearing is how you know it became
            // seekable.
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full disabled:cursor-default [&:disabled::-moz-range-thumb]:opacity-0 [&:disabled::-webkit-slider-thumb]:opacity-0 [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
          />
          {/* One clock, because two will not fit: the length of the call while
              nothing is loaded, the position once something is. `tabular-nums`
              and a fixed width so the digits changing four times a second do
              not shuffle the track beside them. */}
          <span className="w-[34px] shrink-0 text-right text-xs text-text-muted tabular-nums">
            {atRest ? clock(durationS) : clock(elapsed)}
          </span>
        </>
      )}

      {src ? (
        // Keyed on the URL so a re-signed source replaces the element outright
        // instead of relying on browsers agreeing about what changing `src`
        // mid-stream means. No <track>: this is a raw recording and there is no
        // caption file to point at - the drawer's transcript is its text
        // alternative.
        <audio
          key={src}
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            // The row's `duration_s` is whole seconds off the handset; this is
            // the file's own, which is what the progress track is measured in.
            if (Number.isFinite(el.duration) && el.duration > 0) setMeasured(el.duration);
            if (resumeAtRef.current > 0) {
              el.currentTime = resumeAtRef.current;
              setElapsed(resumeAtRef.current);
              resumeAtRef.current = 0;
            }
            if (!autoStartRef.current) return;
            autoStartRef.current = false;
            startPlayback(el);
          }}
          onPlay={(e) => {
            claimPlayback(e.currentTarget);
            setPlaying(true);
          }}
          // `waiting`/`playing` is the pair that says whether sound is actually
          // coming out, as opposed to `play`/`pause`, which only say what was
          // asked for.
          onWaiting={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          onPause={(e) => {
            releasePlayback(e.currentTarget);
            setPlaying(false);
            setBuffering(false);
          }}
          onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
          onEnded={(e) => {
            releasePlayback(e.currentTarget);
            setPlaying(false);
            setBuffering(false);
            // Back to the start, so a second press replays rather than doing
            // nothing on a finished element.
            e.currentTarget.currentTime = 0;
            setElapsed(0);
          }}
          onError={onError}
          className="hidden"
        />
      ) : null}
    </div>
  );
}
