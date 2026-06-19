import { useEffect, useRef, useState } from 'react';

/**
 * Advance the reveal index a steady ~few words per frame, then extend to the
 * next whitespace so whole WORDS appear instead of splitting mid-word.
 *
 * The step is ~13% of the remaining backlog BUT HARD-CAPPED at 18 chars/frame.
 * The cap is the important part: orchestrator replies often arrive as one big
 * chunk (the backend buffers, or the rAF-coalesce batches a whole paragraph
 * into one update), and an uncapped percentage drains that backlog with a
 * front-loaded spike — 185, 145, 115 chars in the first frames — which reads as
 * the text "shooting in" rather than flowing. Capping the per-frame advance
 * turns that single chunk into a steady stream (~18 chars/frame ≈ 1000 chars/s
 * at 60fps: fast, but continuous). The percentage only kicks in for the last
 * ~140 chars, easing the tail to a stop. Pure + synchronous so it's
 * unit-testable without rAF.
 */
export function nextRevealIndex(current: number, text: string): number {
  const len = text.length;
  if (current >= len) return len;
  const remaining = len - current;
  const step = Math.min(18, Math.max(3, Math.ceil(remaining * 0.13)));
  let next = Math.min(len, current + step);
  // Extend to the next whitespace so whole words appear — but cap the search so
  // a giant unbroken token (URL, base64 blob) can't dump in a single frame.
  const cap = next + 12;
  while (next < len && next < cap && !/\s/.test(text[next]!)) next += 1;
  return next;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Smoothly reveal streaming text instead of dumping each network burst.
 *
 * While `streaming`, the returned text catches up to `text` a few chars per
 * animation frame (snapped to word boundaries), giving a steady typewriter feel
 * no matter how bursty the deltas arrive — the orchestrator backend often sends
 * whole lines/paragraphs in one event, which used to pop in as jarring chunks.
 * When not streaming (history, or the turn finished) the full text shows
 * immediately, and reduced-motion users always get it instantly.
 *
 * The rAF loop self-stops when caught up and restarts on the next burst (no idle
 * churn between deltas), and reads the target via a ref so it never streams a
 * stale closure's text.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const reduced = prefersReducedMotion();
  // Once a message has streamed, keep PACING the leftover tail even after
  // `streaming` flips false — the orchestrator often ends a turn (status→ready)
  // while the reveal is still catching up to a big one-shot reply, and snapping
  // the remainder in a single frame is exactly the end-of-turn burst we're
  // avoiding. So animate on (streaming OR ever-streamed); the loop drains to the
  // end and then settles. A never-streamed history message shows full at once.
  const everStreamedRef = useRef(false);
  const animate = (streaming || everStreamedRef.current) && !reduced;
  const [revealed, setRevealed] = useState(animate ? 0 : text.length);
  const idxRef = useRef(animate ? 0 : text.length);
  const targetRef = useRef(text);
  targetRef.current = text;
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    if (streaming) everStreamedRef.current = true;
  }, [streaming]);

  // Not animating (history / reduced-motion) → show everything now.
  useEffect(() => {
    if (animate) return;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    runningRef.current = false;
    idxRef.current = targetRef.current.length;
    setRevealed(targetRef.current.length);
  }, [animate, text]);

  // Drive the reveal. Re-runs whenever `text` grows (a new burst) or `streaming`
  // ends (drain the tail); the loop self-stops when caught up and the next burst
  // restarts it. Reads target via ref → no stale closure.
  useEffect(() => {
    if (!animate) return;
    if (idxRef.current > targetRef.current.length) { idxRef.current = 0; setRevealed(0); } // hook reused by a new stream
    const tick = () => {
      const next = nextRevealIndex(idxRef.current, targetRef.current);
      idxRef.current = next;
      setRevealed(next);
      if (next < targetRef.current.length) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        runningRef.current = false;
        rafRef.current = null;
      }
    };
    if (!runningRef.current && idxRef.current < targetRef.current.length) {
      runningRef.current = true;
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [animate, text, streaming]);

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    runningRef.current = false;
  }, []);

  return animate ? targetRef.current.slice(0, revealed) : text;
}
