import { describe, expect, it } from "vitest";

import {
  classifyFailure,
  failureText,
  leaksVendorDetail,
  PLATFORM_REASON_COOLDOWN_S,
  PLATFORM_REASON_SEVERITY,
  PLATFORM_REASON_TITLE,
  PlatformFailureReason,
} from "./provider-failures";

/**
 * The message that cost 2,792 calls, copied verbatim out of
 * `calls.error_message` on production on 2026-10-14. Every assertion about
 * out-of-credit handling runs against this exact string rather than a
 * paraphrase, because the paraphrase is what the old code would have passed.
 */
const SARVAM_402 = `Sarvam ASR job submit failed
Status code: 402
Body: {
  "error": {
    "message": "No credits available.",
    "code": "insufficient_quota_error",
    "request_id": "20261013_08ef8262-5c61-4a1f-9b2e-1d0c7e5a3b11"
  }
}`;

/** Real shapes from the other providers in the stack. */
const GEMINI_429 = `GoogleGenerativeAI Error: [429 Too Many Requests] Resource has been exhausted (e.g. check quota).`;
const GEMINI_401 = `GoogleGenerativeAI Error: [400 Bad Request] API key not valid. Please pass a valid API key.`;
const MINIO_MISSING = `NoSuchKey: The specified key does not exist. key=recordings/3f2a/call.m4a`;
const NETWORK = `fetch failed: AggregateError [ETIMEDOUT]: connect ETIMEDOUT 10.0.0.4:443`;
const GEMINI_500 = `GoogleGenerativeAI Error: [503 Service Unavailable] The model is overloaded.`;
const EMPTY_AUDIO = `ffprobe: moov atom not found; recording is zero-length`;
const SILENT = `no speech detected in 2412s of audio`;
const UNCONFIGURED = `SARVAM_API_KEY is not set`;

describe("classifyFailure", () => {
  describe("the 402 that ran for 62 days", () => {
    it("is platform, not content", () => {
      const c = classifyFailure("ASR", new Error(SARVAM_402));
      expect(c.failureClass).toBe("platform");
      expect(c.reason).toBe("provider_out_of_credit");
    });

    it("tells the operator which vendor and what to do", () => {
      const { operatorSummary } = classifyFailure("ASR", new Error(SARVAM_402));
      expect(operatorSummary).toMatch(/Sarvam/);
      expect(operatorSummary).toMatch(/no credit or quota/i);
      expect(operatorSummary).toMatch(/every call through this stage will fail/i);
    });

    it("never tells the client about credit, status codes or the vendor", () => {
      const { clientSummary } = classifyFailure("ASR", new Error(SARVAM_402));
      expect(clientSummary).not.toMatch(/sarvam/i);
      expect(clientSummary).not.toMatch(/credit/i);
      expect(clientSummary).not.toMatch(/402/);
      expect(clientSummary).not.toMatch(/quota/i);
      expect(leaksVendorDetail(clientSummary)).toBe(false);
    });

    it("does not blame the recording, which is the specific lie the old copy told", () => {
      const { clientSummary } = classifyFailure("ASR", new Error(SARVAM_402));
      // The copy this replaced: "Speech recognition could not read this
      // recording." Speech recognition never ran.
      expect(clientSummary).not.toMatch(/could not read this recording/i);
      expect(clientSummary).not.toMatch(/no usable speech/i);
    });

    it("says it is being handled and that nothing is needed from them", () => {
      const { clientSummary } = classifyFailure("ASR", new Error(SARVAM_402));
      expect(clientSummary).toMatch(/technical team/i);
      expect(clientSummary).toMatch(/nothing is needed from you/i);
      expect(clientSummary).toMatch(/no call data has been lost/i);
    });

    it("stays retryable, so the call is not spent on an empty wallet", () => {
      expect(classifyFailure("ASR", new Error(SARVAM_402)).retryable).toBe(true);
    });

    it("is blocking, because it does not degrade - it stops everything", () => {
      expect(PLATFORM_REASON_SEVERITY.provider_out_of_credit).toBe("blocking");
    });

    it("parks the provider for hours, not seconds", () => {
      expect(PLATFORM_REASON_COOLDOWN_S.provider_out_of_credit).toBeGreaterThanOrEqual(3600);
    });

    it("classifies the same way from a bare string, an Error, and an attached body", () => {
      const fromString = classifyFailure("ASR", SARVAM_402);
      const fromError = classifyFailure("ASR", new Error(SARVAM_402));
      const withBody = Object.assign(new Error("Sarvam ASR job submit failed"), {
        status: 402,
        body: '{"error":{"code":"insufficient_quota_error"}}',
      });
      expect(fromString.reason).toBe("provider_out_of_credit");
      expect(fromError.reason).toBe("provider_out_of_credit");
      expect(classifyFailure("ASR", withBody).reason).toBe("provider_out_of_credit");
    });
  });

  describe("the rest of the platform family", () => {
    const cases: ReadonlyArray<[string, unknown, PlatformFailureReason]> = [
      ["rate limit", GEMINI_429, "provider_rate_limited"],
      ["bad key", GEMINI_401, "provider_auth_rejected"],
      ["missing object", MINIO_MISSING, "storage_unavailable"],
      ["network", NETWORK, "provider_unreachable"],
      ["vendor 5xx", GEMINI_500, "provider_unavailable"],
      ["nothing configured", UNCONFIGURED, "provider_not_configured"],
    ];

    it.each(cases)("%s is platform/%s", (_name, input, reason) => {
      const c = classifyFailure("ASR", input);
      expect(c.failureClass).toBe("platform");
      expect(c.reason).toBe(reason);
    });

    it.each(cases)("%s tells the client nothing vendor-specific", (_name, input) => {
      const { clientSummary } = classifyFailure("ASR", input);
      expect(leaksVendorDetail(clientSummary)).toBe(false);
    });

    it("gives every platform reason a title, a severity and a cooldown", () => {
      for (const r of PlatformFailureReason.options) {
        expect(PLATFORM_REASON_TITLE[r]).toBeTruthy();
        expect(PLATFORM_REASON_SEVERITY[r]).toBeTruthy();
        expect(PLATFORM_REASON_COOLDOWN_S[r]).toBeGreaterThanOrEqual(0);
      }
    });

    it("does not park on a failure parking cannot help", () => {
      // Our own storage and our own database are not a vendor to back off from.
      expect(PLATFORM_REASON_COOLDOWN_S.storage_unavailable).toBe(0);
      expect(PLATFORM_REASON_COOLDOWN_S.infrastructure_error).toBe(0);
    });

    it("marks a bad key and an unconfigured stage as not worth retrying", () => {
      expect(classifyFailure("ASR", GEMINI_401).retryable).toBe(false);
      expect(classifyFailure("ASR", UNCONFIGURED).retryable).toBe(false);
    });
  });

  describe("content failures stay honest", () => {
    it("a zero-length file is the recording's fault and says so", () => {
      const c = classifyFailure("TRANSCODE", EMPTY_AUDIO);
      expect(c.failureClass).toBe("content");
      expect(c.reason).toBeNull();
      expect(c.retryable).toBe(false);
    });

    it("silence on ASR tells the client there is no transcript, plainly", () => {
      const c = classifyFailure("ASR", SILENT);
      expect(c.failureClass).toBe("content");
      expect(c.clientSummary).toMatch(/no usable speech/i);
      expect(c.clientSummary).toMatch(/still here/i);
    });

    it("does not call it content when a platform signal is also present", () => {
      // This is the ordering that matters: a vendor refusing us often produces
      // an empty transcript downstream, and filing that as "your audio is
      // silent" is how the original bug read to a customer.
      const both = `${SARVAM_402}\nresulting transcript is empty`;
      expect(classifyFailure("ASR", both).failureClass).toBe("platform");
    });
  });

  describe("the default is ours", () => {
    it("treats an unrecognised failure as platform, not as the client's fault", () => {
      const c = classifyFailure("ASR", new Error("something nobody has seen before"));
      expect(c.failureClass).toBe("platform");
      expect(c.reason).toBe("unclassified_platform_error");
    });

    it("still says nothing vendor-specific to the client", () => {
      const c = classifyFailure("ASR", new Error("something nobody has seen before"));
      expect(leaksVendorDetail(c.clientSummary)).toBe(false);
    });

    it("keeps the raw text for the operator so it can be diagnosed", () => {
      const c = classifyFailure("ASR", new Error("something nobody has seen before"));
      expect(c.operatorSummary).toMatch(/something nobody has seen before/);
    });
  });

  describe("no client string in this module leaks, for any stage", () => {
    const inputs = [
      SARVAM_402,
      GEMINI_429,
      GEMINI_401,
      GEMINI_500,
      MINIO_MISSING,
      NETWORK,
      EMPTY_AUDIO,
      SILENT,
      UNCONFIGURED,
      "",
      null,
      undefined,
      42,
      { weird: true },
    ];
    const stages = ["TRANSCODE", "ASR", "ANALYZE", "CRM", "ENRICH", "AGENT", "WHAT_IS_THIS"];

    it("holds across every stage and every input we have on file", () => {
      for (const stage of stages) {
        for (const input of inputs) {
          const c = classifyFailure(stage, input);
          expect(leaksVendorDetail(c.clientSummary)).toBe(false);
          expect(c.clientSummary.length).toBeGreaterThan(20);
        }
      }
    });
  });
});

describe("failureText", () => {
  it("survives everything a catch block can hand it", () => {
    expect(failureText(null)).toBe("");
    expect(failureText(undefined)).toBe("");
    expect(failureText("plain")).toBe("plain");
    expect(failureText(new Error("boom"))).toMatch(/boom/);
    expect(failureText({ a: 1 })).toMatch(/"a":1/);
  });

  it("pulls in status, code and body, which is where the real signal is", () => {
    const err = Object.assign(new Error("submit failed"), {
      status: 402,
      code: "insufficient_quota_error",
      body: '{"error":{"message":"No credits available."}}',
    });
    const text = failureText(err);
    expect(text).toMatch(/402/);
    expect(text).toMatch(/insufficient_quota_error/);
    expect(text).toMatch(/No credits available/);
  });

  it("follows a cause chain", () => {
    const inner = new Error("ECONNRESET");
    const outer = new Error("ASR failed", { cause: inner });
    expect(failureText(outer)).toMatch(/ECONNRESET/);
  });
});

describe("leaksVendorDetail", () => {
  it("catches the things it exists to catch", () => {
    expect(leaksVendorDetail("Sarvam returned an error")).toBe(true);
    expect(leaksVendorDetail("No credits available.")).toBe(true);
    expect(leaksVendorDetail("Status code: 402")).toBe(true);
    expect(leaksVendorDetail("Gemini is overloaded")).toBe(true);
  });

  it("passes the sanitised wording and the generic nouns", () => {
    expect(leaksVendorDetail("Our technical team has been notified automatically.")).toBe(false);
    expect(leaksVendorDetail("There was no usable speech in this recording.")).toBe(false);
  });
});
