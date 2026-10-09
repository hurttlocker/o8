// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { ContextCacheSection, latestContextCacheReuse } from './ContextCacheSection';

const turn = (tokens?: MobileTranscriptEntry['tokens']): MobileTranscriptEntry => ({ id: 'a', role: 'assistant', text: '', tokens });
it('uses the last reported prompt without aggregating previous turns or output', () => {
  const reuse = latestContextCacheReuse([turn({ input: 10, output: 0, cacheRead: 90 }), turn({ input: 200, output: 4_000, cacheRead: 800, cacheWrite: 0 })]);
  expect(reuse).toEqual({ promptTokens: 1_000, readTokens: 800, writeTokens: 0, percent: 80 });
  const markup = renderToStaticMarkup(createElement(ContextCacheSection, { reuse }));
  expect(markup).toContain('80% reused');
  expect(markup).toContain('Expiry is not reported');
  expect(markup).toContain('last response');
});
it('distinguishes zero reuse from missing telemetry', () => {
  expect(latestContextCacheReuse([turn({ input: 100, output: 5, cacheRead: 0 })])?.percent).toBe(0);
  expect(latestContextCacheReuse([turn({ input: 100, output: 5 })])).toBeNull();
  expect(latestContextCacheReuse([])).toBeNull();
  expect(renderToStaticMarkup(createElement(ContextCacheSection, { reuse: null }))).toContain('Awaiting usage');
});
