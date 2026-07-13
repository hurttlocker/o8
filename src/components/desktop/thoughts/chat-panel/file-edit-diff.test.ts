import { describe, expect, it } from 'vitest';

import { splitUnifiedDiff } from '../../o8-panel/diff-render';
import {
  buildFileDiffUrl,
  formatPeekError,
  interpretFileDiffResponse,
  type FileDiffResponse,
} from './file-edit-diff';

// The peek's real seam is: build the file-diff URL → parse the endpoint's JSON
// into one of {diff, empty, error} → render via splitUnifiedDiff. These tests
// drive that parse path with the exact shapes `/api/panel/file-diff` returns.

describe('buildFileDiffUrl', () => {
  it('scopes to one file + workspace root and encodes params', () => {
    const url = buildFileDiffUrl('/repo/src/a b.ts', '/Users/q/o8');
    expect(url.startsWith('/api/panel/file-diff?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('path')).toBe('/repo/src/a b.ts');
    expect(params.get('workspace')).toBe('/Users/q/o8');
  });
});

describe('interpretFileDiffResponse', () => {
  const patch = [
    'diff --git a/src/x.ts b/src/x.ts',
    'index 111..222 100644',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1,3 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    ' const c = 4;',
  ].join('\n');

  it('returns a renderable diff when the endpoint has one', () => {
    const outcome = interpretFileDiffResponse({ diff: patch, hasDiff: true, isUntracked: false } as FileDiffResponse);
    expect(outcome.kind).toBe('diff');
    if (outcome.kind === 'diff') {
      // The diff must survive the real renderer's parse into add/del lines.
      const lines = splitUnifiedDiff(outcome.diff);
      expect(lines.some((l) => l.kind === 'add')).toBe(true);
      expect(lines.some((l) => l.kind === 'del')).toBe(true);
    }
  });

  it('falls back to stagedDiff when diff is empty', () => {
    const outcome = interpretFileDiffResponse({ diff: '', stagedDiff: patch } as FileDiffResponse);
    expect(outcome.kind).toBe('diff');
  });

  it('surfaces an HONEST empty state when the file has no working-tree diff (already committed)', () => {
    const outcome = interpretFileDiffResponse({ diff: '', hasDiff: false, path: 'src/x.ts' } as FileDiffResponse);
    expect(outcome.kind).toBe('empty');
    if (outcome.kind === 'empty') {
      expect(outcome.reason.toLowerCase()).toContain('committed');
    }
  });

  it('propagates a route error', () => {
    const outcome = interpretFileDiffResponse({ error: 'diff failed' });
    expect(outcome).toEqual({ kind: 'error', message: 'diff failed' });
  });

  it('treats a null/absent body as an error, never a blank diff', () => {
    expect(interpretFileDiffResponse(null).kind).toBe('error');
    expect(interpretFileDiffResponse(undefined).kind).toBe('error');
  });

  it('marks untracked (new) files', () => {
    const outcome = interpretFileDiffResponse({ diff: patch, isUntracked: true } as FileDiffResponse);
    expect(outcome.kind === 'diff' && outcome.isUntracked).toBe(true);
  });
});

describe('formatPeekError', () => {
  it('gives a calm message for network failures', () => {
    expect(formatPeekError(new Error('Load failed'))).toMatch(/local diff service/i);
  });

  it('passes through a real error message', () => {
    expect(formatPeekError(new Error('boom'))).toBe('boom');
  });
});
