import { describe, it, expect } from 'vitest';
import {
  brainOffload,
  formatTokenCount,
  isCortexAskTool,
  isMeteredBrainFeedCall,
  parseBrainFeed,
} from './brain-feed';
import type { BrainFeed, MobileTranscriptToolCall } from '@/lib/mobile/types';

// Brain→Fable transparency card — pure logic (2026-07-02). These pin the
// tool-result parsing contract (the MCP handler's jsonResult blob), the
// metered-backend gate, and the offload token math the card renders.

const askPayload = {
  ok: true,
  answer: 'The middleware is default-deny; every /api/* route needs an explicit escape.',
  citations: [
    { kind: 'directive', rowId: 'd-12', table: 'directives', title: 'API security gate', excerpt: '«default-deny»', url: null },
    { kind: 'doc', rowId: 'doc-3', table: 'docs', title: 'CLAUDE.md — API security' },
  ],
  class: 'A',
  retrievalMs: 320,
  classifyMs: 41,
  sourcesConsidered: 18,
  consideredChars: 21400,
  cacheHit: null,
};

describe('isCortexAskTool', () => {
  it('matches the bare and the mcp__o8__-prefixed tool name, nothing else', () => {
    expect(isCortexAskTool('cortex_ask')).toBe(true);
    expect(isCortexAskTool('mcp__o8__cortex_ask')).toBe(true);
    expect(isCortexAskTool('Bash')).toBe(false);
    expect(isCortexAskTool('cortex_propose_observation')).toBe(false);
  });
});

describe('parseBrainFeed', () => {
  it('parses a successful ask result into a structured feed (question from args)', () => {
    const feed = parseBrainFeed(JSON.stringify(askPayload, null, 2), { question: 'How is the API gated?' });
    expect(feed).not.toBeNull();
    expect(feed!.question).toBe('How is the API gated?');
    expect(feed!.answer).toContain('default-deny');
    expect(feed!.citations).toHaveLength(2);
    expect(feed!.citations[0]).toMatchObject({ kind: 'directive', rowId: 'd-12', title: 'API security gate' });
    expect(feed!.sourcesConsidered).toBe(18);
    expect(feed!.retrievalMs).toBe(320);
    expect(feed!.consideredChars).toBe(21400);
    expect(feed!.cacheHit).toBeNull();
  });

  it('recovers the payload when the result string carries wrapper text around the JSON', () => {
    const feed = parseBrainFeed(`Tool output:\n${JSON.stringify(askPayload)}`, { question: 'q' });
    expect(feed?.answer).toContain('default-deny');
  });

  it('returns null for error results, non-JSON output, and non-object payloads', () => {
    expect(parseBrainFeed(JSON.stringify({ ok: false, error: 'cortex_ask failed' }))).toBeNull();
    expect(parseBrainFeed('reading 14 files...')).toBeNull();
    expect(parseBrainFeed('"just a string"')).toBeNull();
    expect(parseBrainFeed('')).toBeNull();
  });

  it('drops malformed citations and tolerates missing optional fields (cache hits)', () => {
    const feed = parseBrainFeed(JSON.stringify({
      ok: true,
      answer: 'cached answer',
      citations: [{ kind: 'fact' }, 'garbage', { kind: 'pr', rowId: '41' }],
      sourcesConsidered: 0,
      retrievalMs: 0,
      cacheHit: 'semantic',
      consideredChars: null,
    }));
    expect(feed).not.toBeNull();
    expect(feed!.citations).toEqual([{ kind: 'pr', rowId: '41', title: undefined, excerpt: undefined, url: null }]);
    expect(feed!.cacheHit).toBe('semantic');
    expect(feed!.consideredChars).toBeNull();
    expect(feed!.question).toBe('');
  });
});

function toolCall(overrides: Partial<MobileTranscriptToolCall>): MobileTranscriptToolCall {
  const feed = parseBrainFeed(JSON.stringify(askPayload), { question: 'q' })!;
  return { name: 'mcp__o8__cortex_ask', brainFeed: feed, backend: 'fable', ...overrides };
}

describe('isMeteredBrainFeedCall', () => {
  it('true only for a parsed feed on a metered backend (fable)', () => {
    expect(isMeteredBrainFeedCall(toolCall({}))).toBe(true);
  });

  it('false on subscription backends, unknown backends, missing backend, or missing feed', () => {
    expect(isMeteredBrainFeedCall(toolCall({ backend: 'claude' }))).toBe(false);
    expect(isMeteredBrainFeedCall(toolCall({ backend: 'codex' }))).toBe(false);
    expect(isMeteredBrainFeedCall(toolCall({ backend: 'not-a-backend' }))).toBe(false);
    expect(isMeteredBrainFeedCall(toolCall({ backend: undefined }))).toBe(false);
    expect(isMeteredBrainFeedCall(toolCall({ brainFeed: undefined }))).toBe(false);
  });
});

describe('brainOffload', () => {
  const feed = (overrides: Partial<BrainFeed>): BrainFeed => ({
    question: 'q',
    answer: 'a'.repeat(400),
    citations: [],
    sourcesConsidered: 18,
    retrievalMs: 320,
    cacheHit: null,
    consideredChars: 21400,
    ...overrides,
  });

  it('derives window vs raw-read tokens (chars / 4, ceil)', () => {
    const offload = brainOffload(feed({}), 1000);
    expect(offload).toEqual({ windowTokens: 250, absorbedTokens: 5350 });
  });

  it('falls back to the answer length when the raw result size is unknown', () => {
    const offload = brainOffload(feed({}));
    expect(offload).toEqual({ windowTokens: 100, absorbedTokens: 5350 });
  });

  it('omits gracefully when consideredChars is missing, zero, or the window is empty', () => {
    expect(brainOffload(feed({ consideredChars: null }), 1000)).toBeNull();
    expect(brainOffload(feed({ consideredChars: 0 }), 1000)).toBeNull();
    expect(brainOffload(feed({ answer: '' }))).toBeNull();
  });
});

describe('formatTokenCount', () => {
  it('renders sub-1k counts plain and larger counts compactly', () => {
    expect(formatTokenCount(842)).toBe('842');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(9412)).toBe('9.4k');
    expect(formatTokenCount(123456)).toBe('123k');
  });
});
