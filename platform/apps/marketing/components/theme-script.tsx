/**
 * Applies the stored theme before the first paint.
 *
 * ── WHY THIS HAS TO BE AN INLINE, SYNCHRONOUS SCRIPT ──────────────────────
 *
 * The preference lives in `localStorage` (see theme-switch.tsx for why it is
 * not a cookie), which no server render can read. If the attribute were set
 * from React's `useEffect` instead, every visitor who chose light while their
 * OS is dark would get one frame of the DARK site before the effect ran - the
 * flash-of-wrong-theme, and it is worst on exactly the slow mid-range Android
 * this site is written for, because the gap between paint and hydration is
 * longest there.
 *
 * A plain `<script>` rendered as the first child of `<body>` executes
 * synchronously, before the browser paints anything after it. `next/script`
 * with `beforeInteractive` would also work and is more machinery for a
 * one-line statement; this stays a string so nothing about it can be deferred.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not touch the attribute when nothing is stored. Absent `data-theme`
 * is the contract for "follow the OS" in both theme.css and brand.css
 * (`:root:not([data-theme="light"])` inside the dark media query), so writing
 * a resolved value here would freeze the visitor out of their own OS setting
 * for the rest of the session.
 *
 * Everything is wrapped in try/catch because reading `localStorage` THROWS,
 * rather than returning null, in a browser with site data blocked. An
 * exception here would run before hydration and take the page down to a blank
 * screen - a colour preference must never be able to do that.
 */
const SCRIPT = `try{var t=localStorage.getItem('auratel-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export function ThemeScript() {
  /* `dangerouslySetInnerHTML` with a build-time constant: the string above is
     authored here, is never user input and never fetched, so there is nothing
     to inject into. Same pattern, and same reasoning, as json-ld.tsx. */
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
