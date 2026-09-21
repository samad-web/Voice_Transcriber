/**
 * Mirrors handsets/page.tsx, which draws nothing: it is a redirect to
 * /owner/devices. Whatever the visitor sees here is therefore the devices page
 * a moment later, so this IS the devices loader - re-exported, not copied. The
 * hop from one loader to the next then changes nothing on screen, and a change
 * to the devices loader carries over without a second edit.
 */
export { default } from "../devices/loading";
