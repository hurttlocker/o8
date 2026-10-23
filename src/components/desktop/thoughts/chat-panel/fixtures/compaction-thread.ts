import type { MobileTranscriptEntry } from '@/lib/mobile/types';

// Invented transcript for rendering tests and the development preview.
const at = new Date(2030, 0, 2, 11, 31).getTime();
export const compactionThread: MobileTranscriptEntry[] = [
  { id: 'orch-user-orch-send-first', role: 'user', text: 'Inspect the sample route.', timestamp: at, timestampLabel: '11:31' },
  { id: 'reply-first', role: 'assistant', text: 'The sample route reaches the worker through the shared router.', timestamp: at + 30_000, timestampLabel: '11:31' },
  { id: 'compact-sample', role: 'system', type: 'compaction', text: 'Context compaction event', timestamp: at + 120_000, timestampLabel: '11:33',
    compaction: { timestamp: at + 120_000, trigger: 'auto', source: 'summary',
      summary: '<compacted_context turns="1" at="2030-01-02 11:33">\nThe route inspection is complete. Keep the shared router boundary for the next check.\n</compacted_context>',
      scorer: { receiptId: 'sample-scores', scores: { 'orch-user-orch-send-first': 1 }, buckets: { keep: ['orch-user-orch-send-first'], drop: [], summarize: [] }, latencyMs: 1, truncated: false },
    } },
  { id: 'orch-user-orch-send-second', role: 'user', text: 'Now verify the sample tests.', timestamp: at + 180_000, timestampLabel: '11:34' },
  { id: 'reply-second', role: 'assistant', text: 'The focused route tests passed. The change is ready for review.', timestamp: at + 210_000, timestampLabel: '11:34' },
];
