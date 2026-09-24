import { BadRequestException } from "@nestjs/common";
import { consolePhone, whatsappPhone } from "./console-phone";

describe("consolePhone", () => {
  it("stores what the console's PhoneInput sends, unchanged", () => {
    expect(consolePhone("+919876543210", "phone", "IN")).toBe("+919876543210");
  });

  it("reads a number typed without a + against the workspace's country", () => {
    expect(consolePhone("98765 43210", "phone", "IN")).toBe("+919876543210");
    expect(consolePhone("50 123 4567", "phone", "AE")).toBe("+971501234567");
  });

  it("treats blank and absent as not given", () => {
    expect(consolePhone(null, "phone", "IN")).toBeNull();
    expect(consolePhone(undefined, "phone", "IN")).toBeNull();
    expect(consolePhone("  ", "phone", "IN")).toBeNull();
  });

  it("refuses a number that is wrong for its country, naming the field", () => {
    expect(() => consolePhone("98765 4321", "whatsapp", "IN")).toThrow(BadRequestException);
    try {
      consolePhone("98765 4321", "whatsapp", "IN");
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { message: Array<{ path: string[] }> };
      expect(body.message[0]?.path).toEqual(["whatsapp"]);
    }
  });

  it("recognises the workspace country code typed without a +", () => {
    // libphonenumber strips a leading 91 when what is left is a valid Indian number.
    expect(consolePhone("919876543210", "phone", "IN")).toBe("+919876543210");
  });

  it("does not read ANOTHER country's bare digits unless asked", () => {
    expect(() => consolePhone("971501234567", "phone", "IN")).toThrow(BadRequestException);
  });
});

describe("whatsappPhone", () => {
  it("accepts WhatsApp's bare international spelling, for any calling code", () => {
    expect(whatsappPhone("919789961631", "phone", "IN")).toBe("+919789961631");
    expect(whatsappPhone("971501234567", "phone", "IN")).toBe("+971501234567");
    expect(whatsappPhone("+91 97899 61631", "phone", "IN")).toBe("+919789961631");
  });

  it("refuses blank and nonsense", () => {
    expect(() => whatsappPhone("", "phone", "IN")).toThrow(BadRequestException);
    expect(() => whatsappPhone("12345", "phone", "IN")).toThrow(BadRequestException);
  });
});
