import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { DbService } from "../db/db.service";

@Controller("health")
// Not throttled (checklist 08 §0.7): the container healthcheck in
// docker-compose.prod.yml polls this every 15s and the uptime monitor polls it
// from outside. A liveness probe that can be rate-limited reports the API down
// precisely when the API is busiest.
@SkipThrottle()
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  async health() {
    // A DB outage is the failure this probe exists to catch - an API process
    // that is still running but can't reach Postgres answers every real
    // request with a 500, so "the process is up" alone is not "healthy".
    try {
      await this.db.adminPool().query("SELECT 1");
    } catch {
      throw new ServiceUnavailableException({ status: "error", service: "aura-api", error: "database unreachable" });
    }
    return { status: "ok", service: "aura-api" };
  }
}
