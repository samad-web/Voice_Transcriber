/**
 * Turn a failed API response into a message worth showing.
 *
 * NestJS's ValidationPipe answers a rejected body with `{ message: [...] }` —
 * one entry per failed field — so a naive `body.message` read (and the bare
 * `API 400` fallback that follows it) throws that detail away. This joins the
 * array back into one line; a plain string `message` (everything else the API
 * throws) passes through unchanged.
 *
 * Shared by every owner-console action file that parses an API error body, so
 * a validation error reads the same everywhere instead of each file
 * reimplementing this slightly differently.
 */
export async function apiErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  const detail = (body as { message?: unknown }).message;
  if (Array.isArray(detail)) {
    return detail.map((d: { message?: string }) => d.message ?? "").join("; ");
  }
  return typeof detail === "string" ? detail : `API ${res.status}`;
}
