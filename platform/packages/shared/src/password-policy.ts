/**
 * What a new console password must satisfy (doc 27 §4.1).
 *
 * ── WHY THESE THREE RULES AND NO MORE ─────────────────────────────────────
 *
 * Length is the rule that matters. Composition rules ("one capital, one
 * symbol") push people to `Password1!`, which meets them and is in every
 * cracking list; NIST 800-63B dropped them for that reason. So:
 *
 *   - at least 10 characters;
 *   - not the password being replaced (a change that changes nothing is the
 *     one outcome the person pressing the button certainly did not want);
 *   - not the account's own email address, the first guess anybody makes.
 *
 * ── AND GOTRUE'S OWN MINIMUM ──────────────────────────────────────────────
 *
 * The self-hosted stack sets no `GOTRUE_PASSWORD_MIN_LENGTH`
 * (supabase/selfhost/.env.selfhost.example), so GoTrue's default of 6 applies.
 * Ours is stricter, which is the safe direction: GoTrue will never refuse a
 * password this policy accepted. If that env is ever set above 10, raise
 * PASSWORD_MIN_LENGTH to match, or people will pass this check and then be
 * refused by the auth server with a message that names a different number.
 */
export const PASSWORD_MIN_LENGTH = 10;

/** GoTrue refuses anything over 72 bytes (bcrypt's limit), so say so first. */
export const PASSWORD_MAX_LENGTH = 72;

export type PasswordProblem = "too_short" | "too_long" | "same_as_current" | "is_email" | "mismatch";

export const PASSWORD_PROBLEM_TEXT: Record<PasswordProblem, string> = {
  too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  too_long: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  same_as_current: "Choose a password different from your current one.",
  is_email: "Your password can't be your email address.",
  mismatch: "The two new passwords don't match.",
};

/** The policy as one sentence, shown under the field before anything is typed. */
export const PASSWORD_POLICY_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, and not your email address.`;

/**
 * Every problem with a proposed password, in the order to show them. Empty
 * means acceptable.
 *
 * `confirm` is optional so the same check serves a server action that has
 * already compared the two fields.
 */
export function passwordProblems(input: {
  next: string;
  current: string;
  email: string;
  confirm?: string;
}): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  // Counted in code points, not UTF-16 units, so an emoji is one character.
  const length = [...input.next].length;
  if (length < PASSWORD_MIN_LENGTH) problems.push("too_short");
  // bcrypt's limit is in BYTES.
  if (new TextEncoder().encode(input.next).length > PASSWORD_MAX_LENGTH) problems.push("too_long");
  if (input.current && input.next === input.current) problems.push("same_as_current");
  const email = input.email.trim().toLowerCase();
  if (email && input.next.trim().toLowerCase() === email) problems.push("is_email");
  if (input.confirm !== undefined && input.confirm !== input.next) problems.push("mismatch");
  return problems;
}
