import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

/**
 * Resolve the org for a platform request. Dev stopgap: the x-org-id header.
 * TODO: derive from the authenticated OIDC principal and move into an
 * interceptor so handlers can never forget it (checklist §2.1).
 */
export function orgIdFromHeader(value: string | string[] | undefined): string {
  const parsed = z.string().uuid().safeParse(Array.isArray(value) ? value[0] : value);
  if (!parsed.success) {
    throw new BadRequestException("x-org-id header (uuid) required");
  }
  return parsed.data;
}
