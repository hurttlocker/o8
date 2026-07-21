// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactRef } from '../../artifacts/types';
import { LaneReviewSummaryHeader } from './LaneReviewSummaryHeader';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function proofArtifact(id: string, phase: 'before' | 'after'): ArtifactRef {
  return {
    id,
    url: `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="${phase === 'before' ? 'red' : 'green'}"/></svg>`,
    kind: 'screenshot',
    source: 'agent-capture',
    phase,
    pairId: 'composer-proof',
    label: 'Composer mode proof',
    width: 40,
    height: 20,
    capturedAt: phase === 'before' ? '2026-07-21T12:00:00.000Z' : '2026-07-21T12:01:00.000Z',
  };
}

describe('LaneReviewSummaryHeader visual proof', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('renders a real before/after packet pair and opens its lightbox', async () => {
    const artifacts = [proofArtifact('proof-before', 'before'), proofArtifact('proof-after', 'after')];

    await act(async () => {
      root.render(createElement(LaneReviewSummaryHeader, {
        summary: 'The fleet preserved the selected solo runtime.',
        files: [{ path: 'src/components/desktop/review/ReviewPanel.tsx', status: 'modified', additions: 4, deletions: 1 }],
        totalAdditions: 4,
        totalDeletions: 1,
        onSelectFile: () => undefined,
        artifacts,
      }));
    });

    expect(container.textContent).toContain("Agent's proof");
    expect(container.textContent).toContain('Bug');
    expect(container.textContent).toContain('Fixed');

    const proofButton = container.querySelector<HTMLButtonElement>('button[title="Composer mode proof"]');
    expect(proofButton).not.toBeNull();
    await act(async () => { proofButton?.click(); });

    expect(document.body.querySelector('button[aria-label="Close"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Composer mode proof');
    expect(document.body.querySelectorAll('img[alt="Composer mode proof"]')).toHaveLength(4);
  });
});
