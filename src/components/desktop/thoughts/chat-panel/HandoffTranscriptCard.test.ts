import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BackendSwitchChoice } from './BackendSwitchChoice';
import { HandoffTranscriptCard } from './HandoffTranscriptCard';

describe('handoff transcript UI', () => {
  it('shows attribution, continuity truth, and dropped-layer count inline', () => {
    const html = renderToStaticMarkup(createElement(HandoffTranscriptCard, {
      handoff: {
        handoffId: 'handoff-card-1',
        from: { backend: 'claude', model: 'source/model' },
        to: { backend: 'codex', model: 'destination/model' },
        lossless: false,
        carries: {
          narrative: 'summary',
          intent: 'full',
          workspace: 'full',
          governance: 'omitted',
          provenance: 'summary',
        },
      },
      timestampLabel: '11:45',
    }));

    expect(html).toContain('source/model');
    expect(html).toContain('destination/model');
    expect(html).toContain('Cold handoff');
    expect(html).toContain('governance omitted');
  });

  it('offers both operator decisions without implying an automatic switch', () => {
    const html = renderToStaticMarkup(createElement(BackendSwitchChoice, {
      target: { backend: 'codex', model: 'destination/model', label: 'Codex' },
      onHandoff: () => undefined,
      onStartFresh: () => undefined,
      onCancel: () => undefined,
    }));

    expect(html).toContain('Start fresh');
    expect(html).toContain('Hand off');
    expect(html).toContain('measured context');
  });
});
