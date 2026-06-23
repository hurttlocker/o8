import { describe, expect, it } from 'vitest';

import {
  buildCitationLookup,
  parseBracketHandles,
  rowDisplayTitle,
  translateCitations,
} from '@/lib/cortex/qa/citations';
import type { CitationKind, TypedRow } from '@/lib/cortex/qa/types';

function row(kind: CitationKind, rowId: string, fields: Record<string, unknown>): TypedRow {
  return {
    citation: {
      kind,
      rowId,
      table: `${kind}s`,
      excerpt: typeof fields.content === 'string' ? fields.content : undefined,
    },
    fields,
  };
}

describe('citation helpers', () => {
  it('derives stable display titles per row kind', () => {
    expect(rowDisplayTitle(row('directive', 'spec-1', { title: 'o8/AGENTS.md — Testing Guidelines' })))
      .toBe('o8/AGENTS.md — Testing Guidelines');

    expect(rowDisplayTitle(row('fact', 'fact-1', { content: 'First fact line\nsecond line' })))
      .toBe('First fact line');
  });

  it('parses spec-ingest handles with colons and multi-handle clusters', () => {
    expect(parseBracketHandles(
      'Use [D-spec-ingest:o8:agents:testing-guidelines, FACT-6f634881] and ignore [not a citation].',
    )).toEqual([
      'D-SPEC-INGEST:O8:AGENTS:TESTING-GUIDELINES',
      'FACT-6F634881',
    ]);
  });

  it('translates exact and abbreviated handles to citation markers', () => {
    const fact = row('fact', '6f634881-f11a-44a0-99dd-aaaaaaaaaaaa', {
      content: 'Run the QA smoke in eval mode.',
    });
    const directive = row('directive', 'spec-ingest:o8:agents:testing-guidelines', {
      title: 'o8/AGENTS.md — Testing Guidelines',
      body: 'Run typecheck before commit.',
    });
    const lookup = buildCitationLookup([fact, directive]);

    const result = translateCitations(
      'Run both gates [FACT-6f634881, D-spec-ingest:o8:agents:testing-guidelines]. Keep [plain text]. Drop [FACT-missing].',
      lookup,
    );

    expect(result.translatedAnswer).toBe(
      'Run both gates [CITATION:fact-6f634881-f11a-44a0-99dd-aaaaaaaaaaaa][CITATION:directive-spec-ingest:o8:agents:testing-guidelines]. Keep [plain text]. Drop .',
    );
    expect(result.verifiedRows).toEqual([fact, directive]);
  });

  it('does not resolve an abbreviated handle when the prefix collides', () => {
    const one = row('fact', '11111111-aaaa-4444-9999-aaaaaaaaaaaa', {
      content: 'First',
    });
    const two = row('fact', '11111111-bbbb-4444-9999-bbbbbbbbbbbb', {
      content: 'Second',
    });
    const lookup = buildCitationLookup([one, two]);

    const result = translateCitations('Ambiguous [FACT-11111111]. Exact [FACT-11111111-aaaa-4444-9999-aaaaaaaaaaaa].', lookup);

    expect(result.translatedAnswer).toBe(
      'Ambiguous . Exact [CITATION:fact-11111111-aaaa-4444-9999-aaaaaaaaaaaa].',
    );
    expect(result.verifiedRows).toEqual([one]);
  });
});

