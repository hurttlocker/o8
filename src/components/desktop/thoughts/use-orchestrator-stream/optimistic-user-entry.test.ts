import { describe, expect, it } from 'vitest';
import { optimisticUserEntry } from './optimistic-user-entry';

describe('optimistic orchestrator user entry', () => {
  it('shows the image sent from the composer beside the user text', () => {
    const entry = optimisticUserEntry({
      id: 'orch-user-1',
      text: 'Inspect this',
      timestamp: 100,
      timestampLabel: '10:00 PM',
      attachments: [{ dataUri: 'data:image/png;base64,aW1hZ2U=', name: 'photo.png' }],
    });
    expect(entry.media).toEqual([{
      kind: 'image', path: 'data:image/png;base64,aW1hZ2U=', name: 'photo.png',
    }]);
  });
});
