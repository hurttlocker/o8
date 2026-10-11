'use client';

import { Fragment, useState, type ReactNode } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { ChatActionCard } from '../thoughts/chat-panel/ChatActionCard';
import { buildTurnSummaryStats, type TurnSummary } from '../thoughts/chat-panel/TurnSummaryCard';
import { TurnChevron } from '../thoughts/chat-panel/turn-line';
import { transcriptTurns, transcriptTurnFiles } from './turns';

export function TranscriptTurns({ entries, nodes, busy, repoPath, summary }: {
  entries: MobileTranscriptEntry[];
  nodes: ReactNode[];
  busy: boolean;
  repoPath?: string | null;
  summary?: TurnSummary | null;
}) {
  return transcriptTurns(entries, busy).map(turn => {
    const finalEntry = turn.final === null ? null : entries[turn.final];
    const receipt = finalEntry?.id === summary?.assistantMessageId ? summary : null;
    const history = new Set(turn.history);
    const files = finalEntry ? transcriptTurnFiles(entries.slice(turn.start, turn.end)) : [];
    return <Fragment key={entries[turn.start].id}>
      {nodes.slice(turn.start, turn.end).map((node, offset) => {
        const index = turn.start + offset;
        if (history.has(index)) return index === turn.history[0]
          ? <WorkHistory key="history" label={receipt ? `Worked for ${elapsedLabel(receipt.elapsedMs)}` : 'Work details'}>
              {turn.history.map(i => <Fragment key={entries[i].id}>{nodes[i]}</Fragment>)}
              {receipt ? <div style={{ fontSize: 11, color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>{buildTurnSummaryStats(receipt).map(stat => stat.value).join(' · ')}</div> : null}
            </WorkHistory>
          : null;
        return <Fragment key={entries[index].id}>
          {node}
          {index === turn.final && files.length > 0 ? <ChatActionCard
            filesEditedCount={files.length} repoPath={repoPath ?? null} filePaths={files.map(file => file.path)}
            files={files} allowUndo={false}
          /> : null}
        </Fragment>;
      })}
    </Fragment>;
  });
}

function elapsedLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function WorkHistory({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} style={{ minWidth: 0 }}>
    <summary style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', listStyle: 'none',
      color: 'var(--t-text-muted)', fontSize: 12, paddingBottom: 10, borderBottom: '1px solid var(--t-divider-subtle)' }}>
      {label}<TurnChevron open={open} />
    </summary>
    {open ? <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 16, paddingBottom: 8 }}>{children}</div> : null}
  </details>;
}
