import { Module } from "@nestjs/common";
import { DbModule } from "../../db/db.module";
import { CrmContextService } from "./crm-context.service";
import { CrmIngestService } from "./crm-ingest.service";
import { McpServerController } from "./mcp-server.controller";
import { PublicApiController } from "./public-api.controller";

/**
 * The external surface: one credential (`api_keys`, 0076), one service, two
 * transports — REST for backends and MCP for model-driven agents.
 *
 * Deliberately does NOT import AuthModule. Every other controller module pulls
 * it in for `AdminKeyGuard`, which needs `AuthService` to resolve user
 * sessions. Nothing here authenticates a person, so nothing here should be able
 * to reach the session machinery.
 */
@Module({
  imports: [DbModule],
  controllers: [PublicApiController, McpServerController],
  providers: [CrmIngestService, CrmContextService],
})
export class PublicApiModule {}
