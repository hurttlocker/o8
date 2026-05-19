'use client';

/**
 * /preview/chat-links — dev scaffold to verify Phase 3: file paths inside chat
 * messages render as clickable FileLinks (via renderInline). Not shipped chrome.
 */

import { ThemeProvider } from '@/lib/theme/context';
import { renderInline } from '@/components/desktop/agent-panel-chat/markdown';

const SAMPLE =
  'I edited `src/components/desktop/review/ReviewPanel.tsx` to fix the diff loader, ' +
  'and also touched src/lib/orchestrator/attempt-log.ts for the turn tracking. ' +
  'The bare path src/app/dashboard/page.tsx wires it up. ' +
  'Plain `inline code` and ordinary words should stay un-linked.';

export default function ChatLinksPreview() {
  return (
    <ThemeProvider>
      <div style={{ position: 'fixed', inset: 0, background: 'var(--t-bg)', paddingTop: 40, paddingBottom: 40, paddingLeft: 40, paddingRight: 40 }}>
        <div style={{ maxWidth: 680, fontFamily: 'var(--font-sans-system)', fontSize: 14, lineHeight: 1.8, color: 'var(--t-text)' }}>
          {renderInline(SAMPLE)}
        </div>
      </div>
    </ThemeProvider>
  );
}
