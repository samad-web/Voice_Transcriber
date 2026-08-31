import { Module } from "@nestjs/common";
import { McpController } from "./mcp.controller";

/** MCP server connections — packages/db/migrations/0074. */
@Module({
  controllers: [McpController],
})
export class McpModule {}
