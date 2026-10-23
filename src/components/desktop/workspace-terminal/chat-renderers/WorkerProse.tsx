'use client';

import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { renderLLMMarkdown } from '@/components/desktop/LLMMarkdown';
import { DesktopAgentMessage } from '@/components/desktop/DesktopAgentMessage';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';

export function WorkerProse({ entry, repoPath, onRunInTerminal }: {
  entry: MobileTranscriptEntry;
  repoPath?: string | null;
  onRunInTerminal?: (command: string) => void;
}) {
  // Preserve specialized receipts, media and actionable notices.
  if (entry.role !== 'assistant' && entry.role !== 'user' || entry.type && entry.type !== 'message') {
    return <DesktopAgentMessage entry={entry} repoPath={repoPath} onRunInTerminal={onRunInTerminal} />;
  }
  if (entry.media?.length) return <>
    {entry.text ? <WorkerProse entry={{ ...entry, media: undefined }} repoPath={repoPath} onRunInTerminal={onRunInTerminal} /> : null}
    <DesktopAgentMessage entry={{ ...entry, text: '' }} repoPath={repoPath} />
  </>;
  const operator = entry.role === 'user';
  return <div data-worker-prose={entry.role} style={{ display: 'flex', justifyContent: operator ? 'flex-end' : 'flex-start', width: '100%', minWidth: 0 }}>
    <div style={{ maxWidth: operator ? '80%' : '100%', minWidth: 0, color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)',
      fontSize: 13, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.5, overflowWrap: 'anywhere',
      paddingTop: operator ? 5 : 0, paddingRight: operator ? 9 : 0, paddingBottom: operator ? 5 : 0, paddingLeft: operator ? 9 : 0,
      borderRadius: operator ? 8 : 0, background: operator ? 'var(--t-chat-surface-input-bg)' : 'transparent' }}>
      {renderLLMMarkdown(sanitizeTranscriptText(entry.text), { compact: true, onRunInTerminal })}
    </div>
  </div>;
}
