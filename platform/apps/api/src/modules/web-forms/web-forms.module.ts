import { Module } from "@nestjs/common";
import { LeadIntakeModule } from "../lead-intake/lead-intake.module";
import { PublicFormsController } from "./public-forms.controller";
import { WebFormSubmissionService } from "./web-form-submission.service";
import { WebFormsController } from "./web-forms.controller";
import { WebFormsService } from "./web-forms.service";

/**
 * The no-code form builder - migration 0161, Build docs/39 §15-§16.
 *
 * ── IT IMPORTS LeadIntakeModule, AND THAT IMPORT IS THE DESIGN ─────────────
 *
 * `LeadIntakeService` is reached by importing the module that provides it, not
 * by re-providing it here - exactly as `LeadIntakeModule` itself imports
 * `PublicApiModule` for `CrmIngestService` rather than re-providing that, and
 * for the same reason written there: one instance, one write path, and no
 * chance of two definitions of what creating a lead means.
 *
 * If a future change makes this module provide its own lead writer, §16 has
 * been broken, whatever the code looks like.
 *
 * ── AND IT DOES NOT IMPORT SuppressionModule ──────────────────────────────
 *
 * The vault write goes through `upsertContactNumber`, the FREE FUNCTION, which
 * takes the caller's own client. `vault.service.ts` says why that function
 * exists alongside the injectable: an intake path should not have to add a
 * module edge to land a side effect, and `CallsController` already reaches
 * across the same boundary the same way.
 *
 * ── TWO CONTROLLERS, TWO TIERS ─────────────────────────────────────────────
 *
 *   WebFormsController    AdminKeyGuard + TenantGuard + CrmPermissionsGuard,
 *                         gated on `web_form` view/create/edit.
 *   PublicFormsController NO guard, by design. A public form is a page on the
 *                         open internet; see that file's header for what
 *                         stands in for one.
 *
 * Both need adding to `CONTROLLERS` in guard-mounting.spec.ts, and the public
 * one to its `UNGUARDED` list, in the integration pass that reconciles the
 * route counts.
 */
@Module({
  imports: [LeadIntakeModule],
  controllers: [WebFormsController, PublicFormsController],
  providers: [WebFormsService, WebFormSubmissionService],
  exports: [WebFormsService],
})
export class WebFormsModule {}
