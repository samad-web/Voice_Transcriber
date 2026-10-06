import { Module } from "@nestjs/common";
import { DncImportService } from "./dnc-import.service";
import { DncController } from "./dnc.controller";
import { NumbersController } from "./numbers.controller";
import { VaultService } from "./vault.service";

/**
 * P0 of the dialer (Build docs/39 §1-§6, migrations 0157 and 0158): the number
 * vault, and the two shapes "do not ring this person" arrives in.
 *
 * ── WHY ONE MODULE FOR BOTH ─────────────────────────────────────────────────
 *
 * They are two tables and two permission objects, but one subsystem: nothing
 * dials without both, `dialability()` reads both in one predicate, and the
 * vault's number and the suppression list's key are the same
 * `sha256(phoneMatchDigits(n))`. Splitting them would put that keying rule in
 * two modules, which is how the DNC list that suppresses nothing gets built.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * No delete route for a list (0158: disabled, never deleted) and no write
 * route for the vault. The vault is filled by the INTAKE paths - the call
 * upload (`VaultService.noteIncomingCall`, wired in calls.controller.ts), and
 * later the form builder and the partner portal - never by hand, which is why
 * `contact_number` carries `view` alone on the permission grid.
 *
 * `VaultService` is exported so those intake paths can reach it;
 * `DncImportService` is not, because the only thing that fills a suppression
 * list is the route in this module.
 */
@Module({
  controllers: [NumbersController, DncController],
  providers: [VaultService, DncImportService],
  exports: [VaultService],
})
export class SuppressionModule {}
