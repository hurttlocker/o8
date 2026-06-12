/**
 * spawn-reveal — a one-shot "o8" materialization written INTO the xterm
 * view, never the PTY: no prompt pollution, no shell history, nothing the
 * server ever sees. Borrowed grammar from Claude Code's CLI polish: one
 * term.write() per frame (xterm batches a single write into one render
 * tick), per-character truecolor, diagonal reveal sweep → one shimmer
 * pass → dissolve. The caller cancels the moment real terminal data
 * arrives — the animation owns the dead air between attach and the first
 * prompt byte, and not one frame more.
 */

interface RevealTerm {
  write: (data: string) => void;
  reset: () => void;
  cols: number;
  rows: number;
}

const MARK = [
  ' ████   ████ ',
  '██  ██ ██  ██',
  '██  ██  ████ ',
  '██  ██ ██  ██',
  ' ████   ████ ',
];

// Tuned so the sweep completes inside a warm zsh spawn (~400-600ms of dead
// air) — the shimmer + dissolve only play when the shell is genuinely slow.
// Real data always wins instantly; the animation never delays the prompt.
const FRAME_MS = 40;
const REVEAL_TICKS = 11;
const SHIMMER_TICKS = 9;
const DISSOLVE_TICKS = 5;

type Rgb = [number, number, number];

// Settled warm paper, the one-orange sweep edge, white shimmer crest.
const SETTLED: Rgb = [203, 199, 192];
const EDGE_BRIGHT: Rgb = [251, 191, 36];
const EDGE_DEEP: Rgb = [245, 158, 11];
const CREST: Rgb = [250, 250, 249];

function lerp(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function fg(color: Rgb): string {
  return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`;
}

/**
 * Start the reveal. Returns cancel(resetTerm) — call with true when real
 * data is about to paint (resets the buffer so the data lands clean), or
 * false on unmount/teardown (timer only, never touches the term).
 *
 * opts.onHoldPoint fires exactly once, when sweep + shimmer have played
 * (or on ANY early exit — cancel, write failure, too-small skip). Hosts
 * that buffer PTY data for a guaranteed first play release it here; the
 * exactly-once-on-every-path contract is what makes buffering deadlock-free.
 */
export function startSpawnReveal(
  term: RevealTerm,
  opts?: { onHoldPoint?: () => void },
): (resetTerm: boolean) => void {
  let holdNotified = false;
  const notifyHold = () => {
    if (holdNotified) return;
    holdNotified = true;
    opts?.onHoldPoint?.();
  };

  // Too small to stage the mark — skip silently (and release any hold).
  if (term.cols < MARK[0].length + 4 || term.rows < MARK.length + 4) {
    notifyHold();
    return () => {};
  }
  const colOff = Math.max(1, Math.floor((term.cols - MARK[0].length) / 2) + 1);
  const rowOff = Math.max(1, Math.floor((term.rows - MARK.length) / 2));
  const TOTAL = REVEAL_TICKS + SHIMMER_TICKS + DISSOLVE_TICKS;
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    notifyHold();
  };

  const frame = (): string => {
    let out = tick === 0 ? '\x1b[?25l\x1b[2J' : '';
    for (let r = 0; r < MARK.length; r += 1) {
      out += `\x1b[${rowOff + r};${colOff}H`;
      let lastColor = '';
      for (let c = 0; c < MARK[r].length; c += 1) {
        if (MARK[r][c] !== '█') {
          out += ' ';
          continue;
        }
        let color: Rgb;
        if (tick < REVEAL_TICKS) {
          // Diagonal wipe — the leading edge burns orange, then settles.
          const edge = tick * 1.35 - r * 0.45;
          if (c > edge) {
            out += ' ';
            continue;
          }
          const dist = edge - c;
          color = dist < 2.6
            ? lerp(EDGE_BRIGHT, EDGE_DEEP, dist / 2.6)
            : dist < 4
              ? lerp(EDGE_DEEP, SETTLED, (dist - 2.6) / 1.4)
              : SETTLED;
        } else if (tick < REVEAL_TICKS + SHIMMER_TICKS) {
          // One white band sweeps the settled mark.
          const sweep = tick - REVEAL_TICKS;
          const center = (sweep * (MARK[0].length + 6)) / SHIMMER_TICKS - 3;
          const boost = Math.max(0, 1 - Math.abs(c - center) / 3);
          color = lerp(SETTLED, CREST, boost * 0.95);
        } else {
          // Dissolve into the glass.
          const k = tick - REVEAL_TICKS - SHIMMER_TICKS + 1;
          const fade = Math.pow(0.72, k);
          color = [
            Math.round(SETTLED[0] * fade),
            Math.round(SETTLED[1] * fade),
            Math.round(SETTLED[2] * fade),
          ];
        }
        const code = fg(color);
        out += (code === lastColor ? '' : code) + '█';
        lastColor = code;
      }
    }
    return out;
  };

  timer = setInterval(() => {
    if (tick === REVEAL_TICKS + SHIMMER_TICKS) {
      // Sweep + shimmer done — release held data. The host may cancel us
      // from inside this callback; bail out of the frame if it did.
      notifyHold();
      if (!timer) return;
    }
    if (tick >= TOTAL) {
      stop();
      try {
        term.write('\x1b[0m\x1b[2J\x1b[H\x1b[?25h');
      } catch {
        // disposed — nothing to clean
      }
      return;
    }
    try {
      term.write(frame());
    } catch {
      stop();
    }
    tick += 1;
  }, FRAME_MS);

  return (resetTerm: boolean) => {
    if (!timer) return; // finished naturally — screen already clean
    stop();
    if (resetTerm) {
      try {
        term.reset();
      } catch {
        // disposed mid-cancel
      }
    }
  };
}
