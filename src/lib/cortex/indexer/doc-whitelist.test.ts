import { describe, expect, it } from 'vitest';

import { defaultWhitelist } from '../../../../scripts/distill-docs';
import { isWhitelisted } from './doc-watcher';

const predicates = [
  ['distill docs', defaultWhitelist],
  ['doc watcher', isWhitelisted],
] as const;

describe.each(predicates)('%s whitelist', (_name, predicate) => {
  it('accepts markdown nested under docs', () => {
    expect(predicate('docs/internals/api.md')).toBe(true);
    expect(predicate('docs/user/vocabulary.md')).toBe(true);
  });

  it('rejects non-markdown files and markdown outside docs', () => {
    expect(predicate('docs/internals/api.txt')).toBe(false);
    expect(predicate('notes/internal.md')).toBe(false);
  });

  it('preserves the existing named-file rules', () => {
    expect(predicate('README.md')).toBe(true);
    expect(predicate('notes/README.md')).toBe(false);
    expect(predicate('packages/client/AGENTS.md')).toBe(true);
  });
});
