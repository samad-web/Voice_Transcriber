import { Module } from "@nestjs/common";
import { IngestController } from "./ingest.controller";
import { IngestService } from "./ingest.service";

/**
 * The ingestion API (`Build docs/no-crm-api-dashboard-build-plan.md` §6,
 * migrations 0193/0194, M2/M3).
 *
 * One controller and one service, and the split between them is the §11
 * latency promise: the controller validates and the service stores a raw
 * event. Neither normalises a fact or touches a KPI - that is the worker's
 * `ingest-drain`, which is why there is no normaliser in this module.
 *
 * `EntitlementsService` is not imported: `EntitlementsModule` is @Global, for
 * the reason stated in its own header.
 */
@Module({
  controllers: [IngestController],
  providers: [IngestService],
})
export class IngestModule {}
