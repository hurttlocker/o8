import { describe, it, expect } from 'vitest';
import { sourcesFromMessages } from './use-thread-sources';

// The Sources card shows the links the OPERATOR put into the conversation — not
// the agent's tool integrations. sourcesFromMessages is the exact extraction the
// hook runs on the fetched transcript, so testing it drives the real path.

describe('sourcesFromMessages — operator links from a thread transcript', () => {
  it('extracts a bare URL from a user message', () => {
    expect(sourcesFromMessages([
      { role: 'user', content: 'look at this https://x.com/FarzaTV/status/2077130366623' },
    ])).toEqual([
      { label: 'x.com/FarzaTV/status/2077130366623', href: 'https://x.com/FarzaTV/status/2077130366623' },
    ]);
  });

  it('keeps the label from a markdown link', () => {
    expect(sourcesFromMessages([
      { role: 'user', content: 'ref: [Cursor hover](https://cursor.com/docs)' },
    ])).toEqual([
      { label: 'Cursor hover', href: 'https://cursor.com/docs' },
    ]);
  });

  it('IGNORES links in assistant messages — only the operator is a source', () => {
    expect(sourcesFromMessages([
      { role: 'assistant', content: 'I found https://internal.example.com/secret' },
      { role: 'user', content: 'and https://example.com/mine' },
    ])).toEqual([
      { label: 'example.com/mine', href: 'https://example.com/mine' },
    ]);
  });

  it('dedupes the same URL across multiple user messages, first-seen order', () => {
    expect(sourcesFromMessages([
      { role: 'user', content: 'https://a.com and https://b.com' },
      { role: 'user', content: 'again https://a.com' },
    ])).toEqual([
      { label: 'a.com', href: 'https://a.com' },
      { label: 'b.com', href: 'https://b.com' },
    ]);
  });

  it('is empty for a conversation with no links', () => {
    expect(sourcesFromMessages([
      { role: 'user', content: 'build me a login page' },
      { role: 'assistant', content: 'done' },
    ])).toEqual([]);
  });

  it('skips non-string / malformed content without throwing', () => {
    expect(sourcesFromMessages([
      { role: 'user' },
      { role: 'user', content: undefined },
      { content: 'https://orphan.com' },
    ])).toEqual([]);
  });
});
