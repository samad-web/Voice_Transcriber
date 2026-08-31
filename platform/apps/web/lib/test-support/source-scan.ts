/**
 * Shared source-scanning primitives for the guard-mounting checks - the
 * `(platform)` Server Action suite and the page-level operator-gate suite
 * both need "find every exported function and look at its body as code, not
 * text" and neither should carry its own copy of a parser this fiddly.
 *
 * Extracted from `(platform)/platform-actions.guard.test.ts` verbatim: same
 * behaviour, same edge cases already found by that suite's own history
 * (template-literal interpolations, an apostrophe inside a block comment).
 */

/**
 * Blank out everything that is not code - line comments, block comments, and
 * the contents of every quoted string and template literal - preserving
 * length and newlines so offsets still line up with the original.
 *
 * Not fastidiousness. Two concrete failures made it necessary:
 *
 *   · `` `${API_URL}/v1/calls/${callId}` `` appears in several of these
 *     files, and a brace counter that did not understand template literals
 *     closes the function early, at the `}` of `${callId}` - then reports a
 *     guarded function as unguarded, or worse, the reverse.
 *   · A doc comment inside a parameter list containing an apostrophe (e.g.
 *     "the environment's") opens a string that never closes and swallows the
 *     rest of the file.
 *
 * Blanking first makes every scanner downstream a plain counter, and it also
 * means a guard call merely MENTIONED in a comment cannot satisfy a check.
 */
export function blankNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      const end = nl === -1 ? source.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(i, end);
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") j += 2;
        else if (source[j] === c) break;
        else j++;
      }
      // Keep the delimiters so the text still reads as a string; blank what
      // is between them, interpolations included.
      blank(i + 1, j);
      i = j;
      continue;
    }
  }
  return out.join("");
}

/** Index of the delimiter matching the one at `open`. Code-only input. */
export function matchDelimiter(code: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === openCh) depth++;
    else if (code[i] === closeCh && --depth === 0) return i;
  }
  throw new Error(
    `unbalanced ${openCh}${closeCh} at ${open} - the scanner is wrong, not the source`,
  );
}

/**
 * From just past a parameter list, the `{` that opens the body. Not simply
 * the next `{`: a return-type annotation legitimately contains one, as in
 * `Promise<{ results?: SearchResult[]; error?: string }>`. The body brace is
 * the first at angle-bracket depth zero.
 */
export function bodyBraceAfter(code: string, from: number): number {
  let angle = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "<") angle++;
    else if (c === ">") angle--;
    else if (c === "{" && angle <= 0) return i;
  }
  throw new Error("no function body found after a parameter list");
}
