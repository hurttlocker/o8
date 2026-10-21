import { describe, expect, it } from 'vitest';
import { addComposerFileReference, readComposerFileReferences, writeComposerFileReferences } from './composer-file-references';

describe('composer file references', () => {
  it('keeps unfinished tokens and agent mentions editable, while preserving email and URL text', () => {
    const text = '@Nova inspect @src/app/page.ts';
    expect(readComposerFileReferences(text)).toEqual({ body: text, paths: [] });
    expect(readComposerFileReferences('Write to q@example.test and @https://example.test now')).toEqual({
      body: 'Write to q@example.test and @https://example.test now', paths: [],
    });
    expect(readComposerFileReferences(`${text} `)).toEqual({ body: '@Nova inspect ', paths: ['src/app/page.ts'] });
  });
  it('round trips quoted paths, code whitespace and duplicate references without completing the next partial token', () => {
    const paths = ['docs/Design notes.md', 'README.md', 'README.md'];
    const body = '  keep this indentation\n@src/unfin';
    const input = writeComposerFileReferences(body, paths);
    expect(readComposerFileReferences(input)).toEqual({ body, paths: paths.slice(0, 2) });
  });
  it('replaces only the active partial token, keeps surrounding text, and supports a files-only draft', () => {
    const input = writeComposerFileReferences('Inspect @src/ then continue', ['README.md']);
    const next = addComposerFileReference(input, 'src/app.ts', 'Inspect @src/'.length);
    expect(readComposerFileReferences(next.input)).toEqual({ body: 'Inspect  then continue', paths: ['README.md', 'src/app.ts'] });
    expect(next.cursor).toBe('Inspect '.length);
    expect(readComposerFileReferences(addComposerFileReference('', 'README.md', 0).input)).toEqual({ body: '', paths: ['README.md'] });
  });
});
