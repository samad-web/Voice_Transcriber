import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prepareAudioForAsr } from "./audio-prep";

const run = promisify(execFile);

/**
 * Audio preparation, and the rule that outranks it.
 *
 * The saving is real - a telecalling recording is 15-30% ringing, hold music
 * and trailing silence, all billed at the speech rate - but it is only ever a
 * saving. If ffmpeg is missing, slow, or produces something implausible, the
 * call must still be transcribed. Every failure path here returns the ORIGINAL
 * buffer, so the two properties under test are "does it trim" and, more
 * importantly, "does it refuse to break a call in order to save money".
 *
 * The trimming tests need a real ffmpeg and are skipped without one, which is
 * also the honest state of a deployment that has not installed it.
 */

let hasFfmpeg = false;
let dir = "";
/** 30s: 8s silence, 6s tone, 5s silence, 4s tone, 7s silence. 10s of "speech". */
let call: Buffer = Buffer.alloc(0);
/** 20s of pure silence - the whole recording is nothing. */
let silentCall: Buffer = Buffer.alloc(0);

async function seconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number(String(stdout).trim());
}

beforeAll(async () => {
  try {
    await run("ffmpeg", ["-version"]);
    hasFfmpeg = true;
  } catch {
    return;
  }
  dir = await mkdtemp(join(tmpdir(), "aura-prep-test-"));
  const piece = async (name: string, args: string[]) => {
    await run("ffmpeg", ["-nostdin", "-y", "-loglevel", "error", ...args, join(dir, name)]);
    return join(dir, name);
  };
  await piece("s1.wav", ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "8"]);
  await piece("t1.wav", ["-f", "lavfi", "-i", "sine=frequency=440:r=16000", "-t", "6"]);
  await piece("s2.wav", ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "5"]);
  await piece("t2.wav", ["-f", "lavfi", "-i", "sine=frequency=660:r=16000", "-t", "4"]);
  await piece("s3.wav", ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "7"]);
  await writeFile(
    join(dir, "list.txt"),
    ["s1.wav", "t1.wav", "s2.wav", "t2.wav", "s3.wav"].map((f) => `file '${f}'`).join("\n"),
  );
  await run("ffmpeg", [
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    join(dir, "list.txt"),
    "-c",
    "copy",
    join(dir, "call.wav"),
  ]);
  await piece("silent.wav", ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "20"]);
  const { readFile } = await import("node:fs/promises");
  call = await readFile(join(dir, "call.wav"));
  silentCall = await readFile(join(dir, "silent.wav"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  delete process.env.ASR_AUDIO_PREP;
});

describe("prepareAudioForAsr - never breaks a call", () => {
  it("returns the original audio when preparation is switched off", async () => {
    process.env.ASR_AUDIO_PREP = "off";

    const out = await prepareAudioForAsr(Buffer.from([1, 2, 3]), "call-1");

    expect(out.audio).toEqual(Buffer.from([1, 2, 3]));
    // null seconds means "we did not establish a billable length", which keeps
    // the caller metering the handset's own duration rather than a guess.
    expect(out.seconds).toBeNull();
  });

  it("returns the original audio rather than throwing on unusable input", async () => {
    // Not audio at all. ffmpeg exits non-zero; the call must still go through.
    const junk = Buffer.from("this is not an audio file", "utf8");

    const out = await prepareAudioForAsr(junk, "call-2");

    expect(out.audio).toEqual(junk);
    expect(out.seconds).toBeNull();
  });

  it("returns the original when the recording is entirely silence", async () => {
    if (!hasFfmpeg) return;
    // Trimming this to nothing would submit an empty file and get back an empty
    // transcript, which reads as a broken call rather than a quiet one.
    const out = await prepareAudioForAsr(silentCall, "call-3");

    expect(out.audio).toEqual(silentCall);
    expect(out.seconds).toBeNull();
  });
});

describe("prepareAudioForAsr - what it saves", () => {
  it("strips leading, interior and trailing silence", async () => {
    if (!hasFfmpeg) return;

    const out = await prepareAudioForAsr(call, "call-4");

    // 30s in, ~10s of tone. The residue is the one-second margin each gap keeps
    // so real conversational pauses are not run together.
    expect(out.seconds).not.toBeNull();
    expect(out.seconds!).toBeGreaterThan(9);
    expect(out.seconds!).toBeLessThan(14);
    expect(out.audio.length).toBeLessThan(call.length);
  });

  it("downmixes to the 16 kHz mono the recogniser wants", async () => {
    if (!hasFfmpeg) return;

    const out = await prepareAudioForAsr(call, "call-5");
    const file = join(dir, "out.m4a");
    await writeFile(file, out.audio);
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=channels,sample_rate",
      "-of",
      "csv=p=0",
      file,
    ]);

    expect(String(stdout).trim()).toContain("16000,1");
  });

  it("caps a long call to roughly the requested length", async () => {
    if (!hasFfmpeg) return;
    // The cap applies AFTER trimming, so ask for less than the ~11s that
    // survives the trim.
    const out = await prepareAudioForAsr(call, "call-6", 6);

    expect(out.seconds).not.toBeNull();
    expect(out.seconds!).toBeLessThanOrEqual(7);
    expect(out.reason).toContain("capped");
  });

  it("leaves a call under the cap alone", async () => {
    if (!hasFfmpeg) return;

    const out = await prepareAudioForAsr(call, "call-7", 600);

    expect(out.reason).not.toContain("capped");
  });

  it("applies no cap at all when the instance has not set one", async () => {
    if (!hasFfmpeg) return;

    const out = await prepareAudioForAsr(call, "call-8", null);

    expect(out.reason).not.toContain("capped");
    expect(out.seconds!).toBeGreaterThan(9);
  });
});
