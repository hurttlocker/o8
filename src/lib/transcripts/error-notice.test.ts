import { describe, it, expect } from 'vitest';
import { isErrorNoticeText, resolveIsErrorNotice } from './error-notice';
import { createOrchestratorDeliveryFailureEntry } from '@/components/desktop/thoughts/use-orchestrator-stream/delivery';

describe('isErrorNoticeText', () => {
  it('detects the notices we author, including their appended detail', () => {
    expect(isErrorNoticeText('Orchestrator error: openclaw gateway exited or failed to spawn')).toBe(true);
    expect(isErrorNoticeText('Message may not have been delivered — the bridge was still starting. Tap to retry.\n\nhey')).toBe(true);
    expect(isErrorNoticeText("Couldn't reach the orchestrator — please re-send.")).toBe(true);
  });

  it('leaves ordinary system news alone', () => {
    expect(isErrorNoticeText('Mission complete — 3 packets merged')).toBe(false);
    expect(isErrorNoticeText('(NEW THREAD · READY)')).toBe(false);
    expect(isErrorNoticeText('')).toBe(false);
    expect(isErrorNoticeText(undefined)).toBe(false);
  });

  it('does not fire on a user quoting an error back', () => {
    expect(isErrorNoticeText('why do I keep getting Orchestrator error: spawn failed?')).toBe(false);
  });
});

describe('resolveIsErrorNotice', () => {
  it('honors the explicit flag over the text', () => {
    expect(resolveIsErrorNotice({ isError: true, text: 'Mission complete' })).toBe(true);
    expect(resolveIsErrorNotice({ isError: false, text: 'Orchestrator error: boom' })).toBe(false);
  });

  it('falls back to text for entries persisted before the flag existed', () => {
    expect(resolveIsErrorNotice({ text: 'Orchestrator error: boom' })).toBe(true);
    expect(resolveIsErrorNotice({ text: 'Mission complete' })).toBe(false);
  });
});

// Real-path seam: the notice the app actually creates must resolve as an error
// through the same call the renderer makes — not just a hand-written string.
describe('delivery failure entry → renderer resolution', () => {
  it('resolves as an error notice, with and without the original text', () => {
    const withText = createOrchestratorDeliveryFailureEntry({ originalText: 'hey' });
    expect(withText.isError).toBe(true);
    expect(resolveIsErrorNotice(withText)).toBe(true);

    const bare = createOrchestratorDeliveryFailureEntry();
    expect(resolveIsErrorNotice(bare)).toBe(true);
  });

  it('still resolves if the flag is stripped in persistence (text fallback holds)', () => {
    const entry = createOrchestratorDeliveryFailureEntry({ originalText: 'hey' });
    const persisted = { text: entry.text };
    expect(resolveIsErrorNotice(persisted)).toBe(true);
  });
});
