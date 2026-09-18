import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { formatDirectiveCitationsSection, type DirectiveCitationsPreview } from '@/lib/judgment/directive-citations-format';
import { DirectiveCitationsRow } from './DirectiveCitationsRow';

const RULE = '- **Never use CSS classes** — inline styles only (`style={{ }}` props).';
const preview: DirectiveCitationsPreview = {
  status: 'ready',
  citations: [{
    directiveId: 'spec-ingest:o8:claude:critical-rules:never',
    ruleId: 'spec-ingest:o8:claude:critical-rules:never#css-classes',
    ruleText: RULE,
    path: 'src/components/Foo.tsx',
    probability: 0.934,
    receiptId: 'jdg_cite_row',
  }],
  receiptIds: ['jdg_cite_row'],
};

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('merge preview rule-citation row', () => {
  it('quotes the rule verbatim with the path, the probability to two decimals, and the receipt id', () => {
    const markup = renderToStaticMarkup(createElement(DirectiveCitationsRow, { preview }));
    expect(markup).toContain('data-o8-directive-citations-row');
    expect(text(markup)).toContain('Advisory · rule citations');
    expect(text(markup)).toContain(`“${RULE}”`);
    expect(text(markup)).toContain('src/components/Foo.tsx · 0.93 · jdg_cite_row');
    expect(markup).not.toContain('class=');
  });

  it('renders no section when the field is absent or off', () => {
    expect(renderToStaticMarkup(createElement(DirectiveCitationsRow, { preview: undefined }))).toBe('');
    expect(renderToStaticMarkup(createElement(DirectiveCitationsRow, { preview: { status: 'off', citations: [], receiptIds: [] } }))).toBe('');
  });

  it('gives the MCP tool the same section as text', () => {
    expect(formatDirectiveCitationsSection(preview)).toBe(`Advisory · rule citations\n"${RULE}" · src/components/Foo.tsx · 0.93 · jdg_cite_row`);
    expect(formatDirectiveCitationsSection(undefined)).toBeNull();
  });
});
