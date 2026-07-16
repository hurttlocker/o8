// Design Mode draw turns carry the full machine context (region, sampled
// elements, screenshot paths) inline in the user text so the model sees it.
// The transcript should NOT render that dump as prose — parse it out so the
// user row shows just the prompt plus a compact expandable context strip.

export interface DesignDrawContext {
  /** The operator's actual prompt (text before the context block). */
  prompt: string;
  /** e.g. "306×156 region at (11, 42)" or "drawn region". */
  regionLabel: string;
  /** Count of sampled `- <tag> …` element lines in the block. */
  elementCount: number;
  /** The full raw context block (marker line onward), for the expanded view. */
  detail: string;
}

const MARKER = '[Design Mode drawing — ';

export function parseDesignDrawContext(text: string): DesignDrawContext | null {
  const idx = text.indexOf(MARKER);
  if (idx === -1) return null;
  const detail = text.slice(idx).trim();
  const headerEnd = detail.indexOf(']');
  if (headerEnd <= MARKER.length) return null;
  return {
    prompt: text.slice(0, idx).trim(),
    regionLabel: detail.slice(MARKER.length, headerEnd).trim(),
    elementCount: detail.split('\n').filter((line) => line.trimStart().startsWith('- <')).length,
    detail,
  };
}
