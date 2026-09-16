import { describe, expect, it } from "vitest";
import { LeadSourceChannel } from "@aura/shared";
import { SOURCE_CHANNELS, sourceChannelInfo } from "./source-channel";

describe("source channels", () => {
  it("labels every channel the database CHECK allows - a new value must not render blank", () => {
    for (const value of LeadSourceChannel.options) {
      expect([value, Boolean(SOURCE_CHANNELS[value]?.label)]).toEqual([value, true]);
    }
  });

  it("groups them the way a sales team talks", () => {
    expect(sourceChannelInfo("call")?.family).toBe("phone");
    expect(sourceChannelInfo("telephony")?.family).toBe("phone");
    expect(sourceChannelInfo("web_form")?.family).toBe("form");
    expect(sourceChannelInfo("meta_ads")?.family).toBe("webhook");
    expect(sourceChannelInfo("whatsapp")?.family).toBe("whatsapp");
  });

  it("returns null for no source or an unknown one, rather than guessing", () => {
    expect(sourceChannelInfo(null)).toBeNull();
    expect(sourceChannelInfo("web_chat")).toBeNull();
  });
});
