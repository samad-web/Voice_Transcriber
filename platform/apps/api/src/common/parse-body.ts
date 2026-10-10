import { BadRequestException } from "@nestjs/common";
import type { ZodType } from "zod";

/**
 * Parse a request body, and turn a validation failure into a 400.
 *
 * ── WHY THIS EXISTS RATHER THAN `Schema.parse(body)` ────────────────────────
 *
 * `.parse()` throws a `ZodError`, which Nest has no mapper for, so it becomes
 * a **500 with the body "Internal server error"**. The caller learns nothing,
 * the log fills with stack traces for ordinary bad input, and an alert fires
 * for somebody forgetting a field.
 *
 * Every controller in this repo therefore writes:
 *
 *     const parsed = Schema.safeParse(body);
 *     if (!parsed.success) throw new BadRequestException(parsed.error.issues);
 *
 * Seventeen call sites in the compliance, document and import controllers used
 * `.parse()` instead and returned 500 for a missing waiver reason. It was
 * found by calling the endpoint, not by a test - a `safeParse` and a `parse`
 * typecheck identically and both "work" on a valid body.
 *
 * So the convention is a function now. It cannot be got wrong by forgetting,
 * and the three-line form is no longer copied eighteen times.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

/** The same, for a body that may legitimately be absent (`{}` is the default). */
export function parseOptionalBody<T>(schema: ZodType<T>, body: unknown): T {
  return parseBody(schema, body ?? {});
}
