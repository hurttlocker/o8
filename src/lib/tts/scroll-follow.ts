/**
 * Shared user-scroll signal for TTS voice-playback line highlighting.
 *
 * While a message is read aloud, the active block auto-scrolls into view. If the
 * operator scrolls away to read elsewhere, we yield: `noteUserScroll()` stamps
 * the moment of a manual scroll gesture (wired to the transcript scroll
 * containers), and `userScrolledRecently()` lets the follow effect skip the
 * auto-scroll for a short grace window so it doesn't yank the viewport back.
 */

let lastUserScrollAt = 0;

/** Record a manual user scroll gesture (wheel / touch-drag). */
export function noteUserScroll(): void {
  lastUserScrollAt = Date.now();
}

/** True if the user scrolled within the last `withinMs` (default 1200ms). */
export function userScrolledRecently(withinMs = 1200): boolean {
  return Date.now() - lastUserScrollAt < withinMs;
}
