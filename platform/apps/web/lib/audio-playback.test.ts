import { describe, expect, it, beforeEach } from "vitest";
import { claimPlayback, playbackHolder, releasePlayback } from "./audio-playback";

/**
 * A media element that behaves like the real one in the way that matters:
 * `pause()` synchronously runs the handler the component attached to the
 * `pause` event, which is what calls `releasePlayback`.
 */
function player(name: string, log: string[]) {
  const self = {
    name,
    paused: true,
    pause() {
      if (self.paused) return;
      self.paused = true;
      log.push(`pause:${name}`);
      // What the component's onPause does.
      releasePlayback(self);
    },
    play() {
      self.paused = false;
      claimPlayback(self);
      log.push(`play:${name}`);
    },
  };
  return self;
}

beforeEach(() => {
  const held = playbackHolder();
  if (held) releasePlayback(held);
});

describe("the console's single playback slot", () => {
  it("pauses the row that was playing when another row starts", () => {
    const log: string[] = [];
    const a = player("a", log);
    const b = player("b", log);

    a.play();
    b.play();

    expect(log).toEqual(["play:a", "pause:a", "play:b"]);
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(false);
  });

  it("leaves the new holder registered after the old one's pause event", () => {
    const log: string[] = [];
    const a = player("a", log);
    const b = player("b", log);
    const c = player("c", log);

    a.play();
    b.play();
    // The regression this pins: if a's `pause` handler had cleared the slot,
    // b would be unregistered and starting c would pause nothing.
    c.play();

    expect(log).toEqual(["play:a", "pause:a", "play:b", "pause:b", "play:c"]);
    expect(b.paused).toBe(true);
  });

  it("does not pause the element that is already playing", () => {
    const log: string[] = [];
    const a = player("a", log);

    a.play();
    claimPlayback(a);

    expect(log).toEqual(["play:a"]);
    expect(a.paused).toBe(false);
  });

  it("forgets an unmounted player so it is never paused again", () => {
    const log: string[] = [];
    const a = player("a", log);
    const b = player("b", log);

    a.play();
    releasePlayback(a);
    expect(playbackHolder()).toBeNull();

    b.play();
    // `a` is gone from the slot, so nothing reached for it.
    expect(log).toEqual(["play:a", "play:b"]);
  });

  it("ignores a release from an element that does not hold the slot", () => {
    const log: string[] = [];
    const a = player("a", log);
    const b = player("b", log);

    a.play();
    releasePlayback(b);

    expect(playbackHolder()).toBe(a);
  });
});
