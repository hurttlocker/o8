import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

const MUTATION_CONSUMERS = [
  'src/components/desktop/InlineDiffViewer.tsx',
  'src/components/desktop/O8InboxPane.tsx',
  'src/components/desktop/merge-beacon/MergeBeacon.tsx',
  'src/components/desktop/review/panel/LaneReviewSummaryHeader.tsx',
  'src/components/desktop/thoughts/mission-panel/RejectedFeedbackPanel.tsx',
  'src/components/desktop/thoughts/mission-panel/review-card/ReviewPane.tsx',
  'src/components/desktop/workspace-terminal/ChatPacketStatusBanner.tsx',
  'src/app/preview/canvas-glass/diff-card.tsx',
];

describe('desktop packet mutation receipts', () => {
  it.each(MUTATION_CONSUMERS)('%s keeps an in-flight replay out of its completion path', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    expect(source).toContain("from '@/lib/orchestrator/action-receipt'");
    expect(source.match(/actionReceiptIsInProgress/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(source.match(/fetchCorrelatedActionReceipt/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('reset and retry button surfaces keep their busy latch while the exact receipt is unresolved', () => {
    const strip = readFileSync(join(ROOT, 'src/components/desktop/thoughts/PacketActionStrip.tsx'), 'utf8');
    expect(strip.match(/if \(!result\.unsettled\) setBusy\(null\)/g)).toHaveLength(2);

    const extraAgents = readFileSync(join(ROOT, 'src/components/desktop/AgentPanelExtraAgents.tsx'), 'utf8');
    expect(extraAgents).toContain('receiptUnsettled = result.unsettled === true');
    expect(extraAgents).toContain('if (!receiptUnsettled) setBusy(false)');
  });
});
