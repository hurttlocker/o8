'use client';

/**
 * AgentIdenticon — deterministic per-agent identity glyph (borrowed from
 * OpenAI Codex's per-agent pixel identicons). Hash the agent's stable id
 * (sessionKey) → a FIXED hue + a 5x5 vertically-symmetric pixel grid, so the
 * SAME agent renders the SAME glyph on every surface (spawned-agents list,
 * session rows, transcripts, mentions, thread panel). Identity ONLY — it never
 * changes with state; the AgentStatusDot beside it carries all state color +
 * motion. Pure function of `seed`: no state, no animation, no time input, so
 * it's identical on every render and every surface.
 */

const GRID = 5;

// djb2 — small, stable string hash. Returns an unsigned 32-bit int.
function hashSeed(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

// xorshift32 PRNG seeded by the hash — well-distributed per-cell bits so the
// grid doesn't degenerate into all-on / all-off / striped patterns.
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}

export function AgentIdenticon({
  seed,
  size = 14,
  title,
}: {
  seed: string | null | undefined;
  size?: number;
  title?: string;
}) {
  const clean = (seed ?? '').trim();
  const radius = Math.max(2, Math.round(size * 0.2));

  // No stable id → neutral placeholder ring, so a row never reflows when an
  // agent's sessionKey is briefly missing (and we don't fake an identity).
  if (!clean) {
    return (
      <span
        aria-hidden
        title={title}
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          borderRadius: radius,
          border: '1px solid var(--t-text-faint, #9ca3af)',
          opacity: 0.4,
          flexShrink: 0,
        }}
      />
    );
  }

  const hash = hashSeed(clean);
  const hue = hash % 360;
  const on = `hsl(${hue}, 58%, 56%)`;
  const ground = `hsla(${hue}, 45%, 50%, 0.14)`;

  // Build the left half + center column from the PRNG, then mirror about the
  // center column for the classic vertically-symmetric identicon read.
  const rng = makeRng(hash);
  const rects: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < GRID; r++) {
    const half: boolean[] = [];
    for (let c = 0; c < 3; c++) half.push(rng() % 100 < 47);
    const cols = [half[0], half[1], half[2], half[1], half[0]];
    for (let c = 0; c < GRID; c++) if (cols[c]) rects.push({ x: c, y: r });
  }

  return (
    <span
      aria-hidden
      title={title}
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        borderRadius: radius,
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 5 5"
        shapeRendering="crispEdges"
        style={{ display: 'block' }}
      >
        <rect x={0} y={0} width={5} height={5} fill={ground} />
        {rects.map(({ x, y }) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={on} />
        ))}
      </svg>
    </span>
  );
}
