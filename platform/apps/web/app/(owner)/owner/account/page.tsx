import { redirect } from "next/navigation";

/**
 * /owner/account is not a page of its own - the account menu links straight
 * to each section. Anyone who types the bare URL lands on Profile, the one
 * section every persona has. On console-loading.test.ts's NO_LOADER list.
 */
export default function AccountIndex() {
  redirect("/owner/account/profile");
}
