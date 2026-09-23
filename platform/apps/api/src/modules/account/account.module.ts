import { Module } from "@nestjs/common";
import { AccountController } from "./account.controller";
import { AuthEventsController } from "./auth-events.controller";

/**
 * A person's own account (doc 27 §4-5): their profile and phone in the
 * workspace they are signed in to, and their sign-in history across every
 * workspace. Nothing here takes a user id from a request body - "me" is always
 * the verified caller the web tier names in its headers.
 */
@Module({
  controllers: [AccountController, AuthEventsController],
})
export class AccountModule {}
