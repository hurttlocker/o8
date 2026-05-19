export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export function splitUnifiedDiff(diff: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;

  return diff.split('\n').map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1] ?? '0', 10);
      newLine = Number.parseInt(hunk[2] ?? '0', 10);
      return { kind: 'hunk', text, oldNumber: null, newNumber: null };
    }

    if (
      text.startsWith('diff --git')
      || text.startsWith('index ')
      || text.startsWith('--- ')
      || text.startsWith('+++ ')
      || text.startsWith('\\ ')
    ) {
      return { kind: 'meta', text, oldNumber: null, newNumber: null };
    }

    if (text.startsWith('+')) {
      return { kind: 'add', text, oldNumber: null, newNumber: newLine++ };
    }

    if (text.startsWith('-')) {
      return { kind: 'del', text, oldNumber: oldLine++, newNumber: null };
    }

    const row = {
      kind: 'context' as const,
      text,
      oldNumber: oldLine || null,
      newNumber: newLine || null,
    };
    if (oldLine) oldLine += 1;
    if (newLine) newLine += 1;
    return row;
  });
}

export function diffLineTone(kind: DiffLineKind) {
  if (kind === 'add') {
    return {
      background: 'color-mix(in srgb, var(--t-terminal-ansi-green, #16a34a) 14%, transparent)',
      color: 'var(--t-terminal-ansi-bright-green, #22c55e)',
    };
  }
  if (kind === 'del') {
    return {
      background: 'color-mix(in srgb, var(--t-brand-red, #ef4444) 14%, transparent)',
      color: 'var(--t-terminal-ansi-bright-red, #ef4444)',
    };
  }
  if (kind === 'hunk') {
    return { background: 'var(--t-bg-subtle)', color: 'var(--t-brand-orange)' };
  }
  if (kind === 'meta') {
    return { background: 'var(--t-bg-subtle)', color: 'var(--t-text-secondary)' };
  }
  return { background: 'transparent', color: 'var(--t-text-muted)' };
}

// ── word-level diff (#1081) ──

export interface WordSegment {
  text: string;
  changed: boolean;
}

/** Split a line body into word + whitespace tokens (whitespace kept as tokens). */
function tokenizeLine(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token.length > 0);
}

function mergeSegments(segments: WordSegment[]): WordSegment[] {
  const merged: WordSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.changed === segment.changed) {
      last.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

// Skip word-diffing pathologically long lines (minified bundles) — the LCS
// table is O(m*n).
const WORD_DIFF_TOKEN_CAP = 240;

/** Word-level diff of two line bodies → per-side segments, changed words flagged. */
export function wordDiff(before: string, after: string): { before: WordSegment[]; after: WordSegment[] } {
  const a = tokenizeLine(before);
  const b = tokenizeLine(after);
  const m = a.length;
  const n = b.length;
  if (m > WORD_DIFF_TOKEN_CAP || n > WORD_DIFF_TOKEN_CAP) {
    return {
      before: before ? [{ text: before, changed: true }] : [],
      after: after ? [{ text: after, changed: true }] : [],
    };
  }
  const width = n + 1;
  const lcs = new Int32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + (j + 1)] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + (j + 1)]);
    }
  }
  const beforeSegs: WordSegment[] = [];
  const afterSegs: WordSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      beforeSegs.push({ text: a[i]!, changed: false });
      afterSegs.push({ text: b[j]!, changed: false });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + (j + 1)]) {
      beforeSegs.push({ text: a[i]!, changed: true });
      i += 1;
    } else {
      afterSegs.push({ text: b[j]!, changed: true });
      j += 1;
    }
  }
  while (i < m) { beforeSegs.push({ text: a[i]!, changed: true }); i += 1; }
  while (j < n) { afterSegs.push({ text: b[j]!, changed: true }); j += 1; }
  return { before: mergeSegments(beforeSegs), after: mergeSegments(afterSegs) };
}

/**
 * Per-line word-diff segments for paired del→add runs in a unified diff.
 * Keyed by the DiffLine object so both the unified and split renderers can
 * look segments up by line.
 */
export function wordDiffSegments(lines: DiffLine[]): Map<DiffLine, WordSegment[]> {
  const map = new Map<DiffLine, WordSegment[]>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.kind !== 'del') {
      index += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    while (lines[index]?.kind === 'del') { dels.push(lines[index]!); index += 1; }
    const adds: DiffLine[] = [];
    while (lines[index]?.kind === 'add') { adds.push(lines[index]!); index += 1; }
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k += 1) {
      const { before, after } = wordDiff(dels[k]!.text.slice(1), adds[k]!.text.slice(1));
      map.set(dels[k]!, before);
      map.set(adds[k]!, after);
    }
  }
  return map;
}
