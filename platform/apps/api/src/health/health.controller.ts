import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";

@Controller("health")
// Not throttled (checklist 08 §0.7): the container healthcheck in
// docker-compose.prod.yml polls this every 15s and the uptime monitor polls it
// from outside. A liveness probe that can be rate-limited reports the API down
// precisely when the API is busiest.
@SkipThrottle()
export class HealthController {
  @Get()
  health() {
    return { status: "ok", service: "aura-api" };
  }
}
