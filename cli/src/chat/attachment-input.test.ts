import { describe, expect, it } from 'vitest';
import { attachmentPaths, attachmentTurn, pastedAttachmentPaths } from './attachments.js';

describe('terminal attachment input', () => {
  it('handles dropped quoting without evaluating shell expressions', () => {
    expect(attachmentPaths("'/tmp/one image.png' /tmp/two\\ image.png")).toEqual(['/tmp/one image.png', '/tmp/two image.png']);
    expect(attachmentPaths("'/tmp/$(touch secret).txt'")).toEqual(['/tmp/$(touch secret).txt']);
    expect(() => attachmentPaths("'unfinished")).toThrow('quoting');
    expect(() => attachmentPaths('/tmp/a\n/quit')).toThrow('one line');
    expect(pastedAttachmentPaths('please review /tmp/a')).toBeNull();
    expect(pastedAttachmentPaths('/tmp/a /tmp/b')).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('sends file bytes as data while keeping large content out of the displayed prompt', () => {
    const turn = attachmentTurn('Review', [{ path: '/tmp/note.txt', name: 'note.txt', bytes: 4, text: 'a\n"b' }]);
    expect(turn.displayMessage).toBe('Review\n[File: note.txt]');
    expect(JSON.parse(turn.message.split('Attached files (JSON data):\n')[1]!)).toEqual([{ name: 'note.txt', content: 'a\n"b' }]);
    expect(turn.attachments).toEqual([]);
  });
});
