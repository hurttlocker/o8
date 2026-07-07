import { describe, it, expect } from 'vitest';
import {
  BUYIN_DOC_FILENAME,
  buildBuyinDocPrompt,
  shouldGenerateBuyinDoc,
  type GenerateBuyinDocParams,
} from './buyin-doc';

const baseParams: GenerateBuyinDocParams = {
  repoPath: '/repo',
  laneId: 'lane-1',
  packetId: 'pkt-1',
  packetTitle: 'Add favorites',
  packetSummary: 'Users can now favorite dashboards',
  mergeSha: 'abc123',
  deviationsRaw: null,
  demoArtifacts: [],
};

describe('shouldGenerateBuyinDoc', () => {
  it('requires enabled + merged + a real packet id', () => {
    expect(shouldGenerateBuyinDoc({ enabled: true, mergeOk: true, packetId: 'pkt-1' })).toBe(true);
    expect(shouldGenerateBuyinDoc({ enabled: false, mergeOk: true, packetId: 'pkt-1' })).toBe(false);
    expect(shouldGenerateBuyinDoc({ enabled: true, mergeOk: false, packetId: 'pkt-1' })).toBe(false);
    expect(shouldGenerateBuyinDoc({ enabled: true, mergeOk: true, packetId: null })).toBe(false);
    expect(shouldGenerateBuyinDoc({ enabled: true, mergeOk: true, packetId: '   ' })).toBe(false);
  });
});

describe('buildBuyinDocPrompt', () => {
  it('orders the doc demo-first with objections pre-answered', () => {
    const prompt = buildBuyinDocPrompt(baseParams);
    expect(prompt).toContain(BUYIN_DOC_FILENAME);
    expect(prompt).toMatch(/DEMO \/ PROOF FIRST/);
    expect(prompt).toMatch(/Objections pre-answered/i);
    expect(prompt).toMatch(/plain language/i);
    // Demo section ("1.") must be ordered ahead of objections ("5.").
    expect(prompt.indexOf('1. DEMO')).toBeLessThan(prompt.indexOf('5. Objections'));
  });

  it('enforces content-safety forbiddens for external sharing', () => {
    const prompt = buildBuyinDocPrompt(baseParams);
    expect(prompt).toMatch(/CONTENT SAFETY/);
    expect(prompt).toMatch(/do NOT include secrets, API keys, tokens/i);
    expect(prompt).toMatch(/absolute local filesystem paths/i);
    expect(prompt).toMatch(/internal-only URLs/i);
    // No external network dependencies — the doc must render offline.
    expect(prompt).toMatch(/no external assets, no network requests/i);
  });

  it('leads with a plain-language summary and forbids placeholder images when no demo exists', () => {
    const prompt = buildBuyinDocPrompt(baseParams);
    expect(prompt).toMatch(/No demo artifacts were captured/);
    expect(prompt).toMatch(/do NOT fabricate screenshots or insert placeholder images/i);
  });

  it('tells the agent to inline captured images as data URIs (self-contained)', () => {
    const prompt = buildBuyinDocPrompt({
      ...baseParams,
      demoArtifacts: [
        { absPath: '/data/artifacts/pkt-1/a.png', label: 'before', phase: 'before', kind: 'screenshot', mimeType: 'image/png' },
        { absPath: '/data/artifacts/pkt-1/b.png', label: 'after', phase: 'after', kind: 'screenshot', mimeType: 'image/png' },
      ],
    });
    expect(prompt).toMatch(/LEAD the document with these/);
    expect(prompt).toMatch(/base64 `data:` URI/);
    expect(prompt).toContain('/data/artifacts/pkt-1/a.png');
  });
});
