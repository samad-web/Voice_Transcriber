import { describe, expect, it } from "vitest";
import { OwnerRole } from "@aura/shared";
import {
  accountCrumbsFor,
  accountDisplayName,
  accountInitials,
  accountMenuItemsFor,
  canOpenAccountPage,
  seesStorageInMenu,
} from "./account-menu";

const ids = (items: ReturnType<typeof accountMenuItemsFor>) => items.map((i) => i.id);

describe("accountMenuItemsFor (doc 27 §2.2)", () => {
  it("gives the owner every entry", () => {
    expect(ids(accountMenuItemsFor("owner", "owner"))).toEqual([
      "profile",
      "notifications",
      "business",
      "time",
      "plan",
      "login_activity",
      "sign_out_all",
      "sign_out",
    ]);
  });

  it("gives the manager every entry too - the business profile opens read-only, the time zone editable", () => {
    expect(ids(accountMenuItemsFor("owner", "manager"))).toEqual([
      "profile",
      "notifications",
      "business",
      "time",
      "plan",
      "login_activity",
      "sign_out_all",
      "sign_out",
    ]);
  });

  it.each(["telecaller", "sales", "marketing"] as const)(
    "gives a %s only Profile, notifications, Login activity and the two sign-outs",
    (role) => {
      expect(ids(accountMenuItemsFor("owner", role))).toEqual([
        "profile",
        "notifications",
        "login_activity",
        "sign_out_all",
        "sign_out",
      ]);
    },
  );

  it("gives the operator console Profile and Login activity at its own URLs", () => {
    const items = accountMenuItemsFor("platform");
    expect(ids(items)).toEqual(["profile", "login_activity", "sign_out_all", "sign_out"]);
    expect(items.find((i) => i.id === "profile")?.href).toBe("/account/profile");
    expect(items.find((i) => i.id === "login_activity")?.href).toBe("/account/login-activity");
  });

  it("labels the third entry Plan & usage, not Billing", () => {
    expect(accountMenuItemsFor("owner", "owner").find((i) => i.id === "plan")?.label).toBe("Plan & usage");
  });

  it("never offers a page its own gate would refuse", () => {
    for (const role of OwnerRole.options) {
      for (const item of accountMenuItemsFor("owner", role)) {
        if (item.id === "business") expect(canOpenAccountPage("business", role)).toBe(true);
        if (item.id === "plan") expect(canOpenAccountPage("plan", role)).toBe(true);
      }
    }
  });

  it("makes the sign-out rows buttons, not links", () => {
    for (const item of accountMenuItemsFor("owner", "owner").filter((i) => i.group === "session")) {
      expect(item.href).toBeUndefined();
    }
  });
});

describe("seesStorageInMenu", () => {
  it("is owner and manager of a workspace only", () => {
    expect(seesStorageInMenu("owner", "owner")).toBe(true);
    expect(seesStorageInMenu("owner", "manager")).toBe(true);
    expect(seesStorageInMenu("owner", "telecaller")).toBe(false);
    expect(seesStorageInMenu("platform", null)).toBe(false);
  });
});

describe("accountInitials / accountDisplayName", () => {
  it("prefers the name, falls back to the email", () => {
    expect(accountInitials("Abdul Samad", "x@y.in")).toBe("AS");
    expect(accountInitials("Priya", "x@y.in")).toBe("PR");
    expect(accountInitials(null, "abdul@acme.in")).toBe("AB");
    expect(accountInitials(null, "")).toBe("?");
    expect(accountDisplayName("  ", "abdul@acme.in")).toBe("abdul");
    expect(accountDisplayName("Abdul Samad", "abdul@acme.in")).toBe("Abdul Samad");
  });
});

describe("accountCrumbsFor", () => {
  it("reads Home > Account > Profile", () => {
    expect(accountCrumbsFor("/owner/account/profile")).toEqual([
      { label: "Home", href: "/owner" },
      // Linked, so only the last crumb is aria-current="page".
      { label: "Account", href: "/owner/account" },
      { label: "Profile" },
    ]);
  });

  it("reads Home > Get started, one level - these pages are not in the rail", () => {
    expect(accountCrumbsFor("/owner/get-started/")).toEqual([{ label: "Home", href: "/owner" }, { label: "Get started" }]);
  });

  it("leaves every other page to the nav", () => {
    expect(accountCrumbsFor("/owner/contacts")).toBeNull();
    expect(accountCrumbsFor("/owner/account")).toBeNull();
  });
});
