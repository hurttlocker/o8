import { describe, expect, it } from 'vitest';
import review from '../native/o8-next/fixtures/review.history.json';
import reviewTree from '../native/o8-next/fixtures/review.tree.json';
import tools from '../native/o8-next/fixtures/tools.history.json';
import toolsTree from '../native/o8-next/fixtures/tools.tree.json';
import long from '../native/o8-next/fixtures/long.history.json';
import longTree from '../native/o8-next/fixtures/long.tree.json';
import { webTree } from '../scripts/next/web-tree';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

// Rust tests consume these same trees. This side calls the production web
// renderer, so a web behavior change cannot silently leave the Rust oracle stale.
describe('native recorded render-tree parity with the web transcript', () => {
  for (const [name, history, tree] of [['review', review, reviewTree], ['tools', tools, toolsTree], ['long', long, longTree]] as const) {
    it(`${name}: preserves content, roles, blocks, order, code bytes, inline styles and tool groups`, () => {
      expect(webTree(history.transcript as MobileTranscriptEntry[])).toEqual(tree);
    });
  }
  it('detects reordered messages and changed code or tool grouping', () => {
    const reversed = [...review.transcript].reverse();
    expect(webTree(reversed as MobileTranscriptEntry[])).not.toEqual(reviewTree);
    const code = structuredClone(review.transcript);
    code[1].text = code[1].text.replace('    true', '    false');
    expect(webTree(code as MobileTranscriptEntry[])).not.toEqual(reviewTree);
    const toolsChanged = structuredClone(tools.transcript) as MobileTranscriptEntry[];
    toolsChanged[1].toolCalls![1].args = { command: 'cargo test' };
    expect(webTree(toolsChanged)).not.toEqual(toolsTree);
  });
  it('records the exact tail returned by the current server contract', () => {
    expect(long.transcript).toHaveLength(100);
    expect(long.transcript[0].id).toBe('long-21');
    expect(long.transcript.at(-1)?.id).toBe('long-120');
  });
});
