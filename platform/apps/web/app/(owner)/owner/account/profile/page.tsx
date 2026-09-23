import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { PasswordCard } from "@/components/password-card";
import { PreferencesCard } from "@/components/preferences-card";
import { accountPageRoles } from "@/lib/account-menu";
import { ownerTry, requireOwnerRoles } from "@/lib/owner-context";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { ProfileDetails, type ProfileView } from "./profile-client";

export const metadata: Metadata = { title: "Profile" };

/**
 * Profile (doc 27 §4.1) - every persona's own details, password and
 * preferences. A core page, not a feature: nothing an operator switches off
 * may hide a person's password page, so there is no requireFeature here and
 * no entry in features.ts.
 */
export default async function ProfilePage() {
  await requireOwnerRoles(accountPageRoles("profile"));
  const result = await ownerTry<ProfileView>("/v1/account/profile");

  return (
    <>
      <PageHeader title="Profile" context="Account" />
      {result.ok ? (
        <ProfileDetails profile={result.data} passwordRequired={AUTH_ENABLED} />
      ) : (
        <LoadFailure what="your details" failure={result} />
      )}
      <PasswordCard enabled={AUTH_ENABLED} />
      <PreferencesCard />
    </>
  );
}
