'use client';

import { useRef, useState } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { ComposerPopover } from '../thoughts/chat-panel/ComposerPopover';
import { SwarmStatusCard, focusSwarmPacket } from '../thoughts/chat-panel/SwarmStatusCard';
import { ChatActionCard } from '../thoughts/chat-panel/ChatActionCard';
import { FloatingSurface } from '../FloatingSurface';
import { transcriptTurnFiles } from './turns';
import { transcriptPlan, transcriptScouts } from './activity';

export function TranscriptActivity({ entries, packets, busy, repoPath, onFocusPacket }: {
  entries: MobileTranscriptEntry[]; packets: OrchestratorPacket[]; busy: boolean;
  repoPath?: string | null; onFocusPacket?: (packet: OrchestratorPacket) => void;
}) {
  const [open, setOpen] = useState<'agents' | 'changes' | 'plan' | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const lastUser = entries.findLastIndex(entry => entry.role === 'user');
  const turn = entries.slice(Math.max(0, lastUser));
  const files = transcriptTurnFiles(turn);
  const scouts = transcriptScouts(turn, busy);
  const plan = transcriptPlan(turn);
  const visiblePackets = packets.filter(packet => packet.status !== 'draft' && packet.status !== 'idle');
  if (!visiblePackets.length && !scouts.length && !plan.length && !(busy && files.length)) return null;
  const agentCount = visiblePackets.length + scouts.length;
  const chips = [
    ...(visiblePackets.length + scouts.length ? [{ key: 'agents' as const, label: `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}` }] : []),
    ...(plan.length ? [{ key: 'plan' as const, label: `Plan · ${plan.filter(step => step.status === 'completed').length}/${plan.length}` }] : []),
    ...(busy && files.length ? [{ key: 'changes' as const, label: `${files.length} ${files.length === 1 ? 'file' : 'files'} changed` }] : []),
  ];
  return <div ref={anchor} style={{ display: 'flex', justifyContent: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
    {chips.map(chip => <button key={chip.key} type="button" aria-haspopup="dialog" aria-expanded={open === chip.key}
      onClick={() => setOpen(open === chip.key ? null : chip.key)} style={{ border: '1px solid var(--t-divider)', borderRadius: 999,
        paddingTop: 5, paddingBottom: 5, paddingLeft: 11, paddingRight: 11, color: 'var(--t-text-secondary)', background: 'var(--t-input-bg)', fontSize: 11, cursor: 'pointer' }}>
      {chip.label}<span aria-hidden="true" style={{ marginLeft: 6 }}>›</span>
    </button>)}
    <ComposerPopover anchorRef={anchor} open={open !== null && chips.some(chip => chip.key === open)} onClose={() => setOpen(null)}>
      <FloatingSurface overlay role="dialog" aria-label={open === 'agents' ? 'Agents in this conversation' : open === 'plan' ? 'Task plan' : 'Current changes'}
        style={{ width: 'min(420px, calc(100vw - 24px))', borderRadius: 16 }} contentStyle={{ padding: 14, maxHeight: 'min(420px, 65vh)', overflowY: 'auto' }}>
        {open === 'agents' ? <SwarmStatusCard packets={visiblePackets} scouts={scouts} onFocusPacket={packet => { setOpen(null); focusSwarmPacket(packet, onFocusPacket); }} /> : null}
        {open === 'changes' ? <ChatActionCard filesEditedCount={files.length} files={files} filePaths={files.map(file => file.path)} repoPath={repoPath ?? null} allowUndo={false} /> : null}
        {open === 'plan' ? <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <strong style={{ fontSize: 12 }}>Task plan</strong>
          {plan.map((step, index) => <div key={index} style={{ display: 'flex', gap: 10, fontSize: 12, lineHeight: 1.5, color: step.status === 'completed' ? 'var(--t-text-muted)' : 'var(--t-text)' }}>
            <span aria-label={step.status.replace('_', ' ')}>{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '◉' : '○'}</span><span>{step.text}</span>
          </div>)}
        </div> : null}
        <button type="button" onClick={() => setOpen(null)} style={{ marginTop: 12, border: 0, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11, cursor: 'pointer' }}>Close</button>
      </FloatingSurface>
    </ComposerPopover>
  </div>;
}
