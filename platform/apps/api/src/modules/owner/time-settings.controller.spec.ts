import { timeZoneSpellings } from "@aura/shared";
import { chooseZoneSpelling } from "./time-settings.controller";

describe("chooseZoneSpelling (doc 30)", () => {
  it("stores the current IANA name when the database knows it", () => {
    expect(chooseZoneSpelling(timeZoneSpellings("Europe/Kyiv"), ["Europe/Kyiv", "Europe/Kiev"])).toBe("Europe/Kyiv");
  });

  it("falls back to the legacy spelling an older tzdata still has", () => {
    expect(chooseZoneSpelling(timeZoneSpellings("Europe/Kyiv"), ["Europe/Kiev"])).toBe("Europe/Kiev");
  });

  it("folds ICU's legacy input onto the current name first", () => {
    expect(timeZoneSpellings("Asia/Calcutta")[0]).toBe("Asia/Kolkata");
    expect(chooseZoneSpelling(timeZoneSpellings("Asia/Calcutta"), ["Asia/Kolkata", "Asia/Calcutta"])).toBe(
      "Asia/Kolkata",
    );
  });

  it("refuses a zone the database knows under no spelling", () => {
    expect(chooseZoneSpelling(["Pacific/Kanton", "Pacific/Enderbury"], [])).toBeNull();
  });
});
