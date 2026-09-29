import { createHash } from "node:crypto";

/**
 * What a person's WhatsApp relay instance is called in Evolution GO's own
 * manager console.
 *
 * ── WHY THIS IS NOT JUST `AURA-<instance>-<person>` ─────────────────────────
 *
 * It very nearly is, and that is the point: the previous name was
 * `aura-<orgId>-<userId>`, seventy-eight characters of uuid, in a console that
 * shows a column of them. Unreadable, which is exactly what its own comment
 * claimed it was avoiding.
 *
 * The four hex characters on the end are the one deliberate departure, and they
 * are there because **the relay is shared between every tenant on the
 * deployment** - fourteen instances across four organisations at the time of
 * writing. Names are not unique the way uuids are: two workspaces both called
 * "Main" with a person called "Sam" in each produce the same string, and
 * `POST /instance/create` addressed at an existing name does not fail loudly so
 * much as hand back the instance that is already there. That outcome is one
 * tenant's WhatsApp session answering another tenant's messages, which is a
 * cross-tenant data leak dressed up as a naming collision.
 *
 * So the suffix is a digest of `orgId:userId`: deterministic (the same person
 * always resolves to the same name), invisible in practice (four characters on
 * the end of a short name), and enough to make the collision above
 * unrepresentable rather than merely unlikely.
 *
 * The name is computed ONCE and stored in `config.evolutionInstance`; nothing
 * recomputes it. Renaming a workspace or a person therefore never orphans a
 * live session - the stored name keeps addressing the same relay instance.
 */
export function evolutionInstanceName(input: {
  instance: string | null;
  person: string | null;
  orgId: string;
  userId: string;
}): string {
  const suffix = createHash("sha256")
    .update(`${input.orgId}:${input.userId}`)
    .digest("hex")
    .slice(0, 4);
  return ["AURA", slug(input.instance) || "workspace", slug(input.person) || "user", suffix].join(
    "-",
  );
}

/**
 * A name segment the relay can carry in a URL path and a person can still read.
 *
 * Accents are folded rather than dropped (NFD, then strip the combining marks),
 * so "José" reads as "Jose" and not as "Jos". Everything else outside
 * [A-Za-z0-9] collapses to a single dash, and each segment is capped so one
 * long workspace name cannot push the whole instance name back to where it
 * started.
 */
function slug(value: string | null): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
}
