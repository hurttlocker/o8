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
