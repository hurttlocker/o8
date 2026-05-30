'use client';

/**
 * OrchestratorStatusDetail — the inline drawer body for a status card. Explains,
 * in plain language, exactly what happened (so the operator is never left
 * guessing) plus Issues-style metadata rows and, for mission-complete, the
 * free-AI "What shipped" summary. Rendered inline BELOW the card as a drop-down
 * drawer — NOT a modal — so opening it never blurs the chat or breaks the
 * operator's flow.
 *
 * House rules: inline styles only, themed tokens so it reads in light + midnight.
 */

import { useEffect, useState } from 'react';
import {
  humanizeLaneStatus,
  type OrchestratorStatusEventData,
} from '@/lib/orchestrator/status-events';

function detailContent(event: OrchestratorStatusEventData): { explain: string; rows: { label: string; value: string }[] } {
  switch (event.kind) {
    case 'mission-complete':
      return {
        explain: event.packets && event.packets.length > 0
          ? 'Every packet in this mission was reviewed, merged into the base branch, and its lane archived. Here is what shipped.'
          : 'Every packet in this mission was reviewed, merged into the base branch, and its lane archived. The thread is ready for your next mission.',
        rows: [
          { label: 'Merged', value: `${event.mergedCount} ${event.mergedCount === 1 ? 'packet' : 'packets'}` },
          ...(typeof event.archivedCount === 'number'
            ? [{ label: 'Archived', value: `${event.archivedCount} ${event.archivedCount === 1 ? 'lane' : 'lanes'}` }]
            : []),
        ],
      };
    case 'merge':
      return {
        explain: `These changes were reviewed and merged into ${event.branch || 'the base branch'}. The packet's worktree lane is now retired.`,
        rows: [
          { label: 'Packet', value: event.packetTitle },
          ...(event.branch ? [{ label: 'Branch', value: event.branch }] : []),
          ...(event.runtime ? [{ label: 'Runtime', value: event.runtime }] : []),
        ],
      };
    case 'heal':
      return event.outcome === 'recovered'
        ? {
            explain: `o8 detected a failed step${event.previousStatus ? ` (${humanizeLaneStatus(event.previousStatus)})` : ''} and automatically recovered this lane — re-running it through the orchestrator. No action needed from you.`,
            rows: [
              ...(event.packetTitle ? [{ label: 'Packet', value: event.packetTitle }] : []),
              { label: 'Outcome', value: 'Recovered automatically' },
              ...(event.previousStatus ? [{ label: 'Recovered from', value: humanizeLaneStatus(event.previousStatus) }] : []),
            ],
          }
        : {
            explain: `Automatic recovery couldn't resolve the failure${event.previousStatus ? ` (${humanizeLaneStatus(event.previousStatus)})` : ''}, so the lane is paused for your input. Open it from the inbox to steer or restart it.`,
            rows: [
              ...(event.packetTitle ? [{ label: 'Packet', value: event.packetTitle }] : []),
              { label: 'Outcome', value: 'Needs your input' },
              ...(event.previousStatus ? [{ label: 'After', value: humanizeLaneStatus(event.previousStatus) }] : []),
            ],
          };
  }
}

export function OrchestratorStatusDetailBody({ event }: { event: OrchestratorStatusEventData }) {
  const { explain, rows } = detailContent(event);
  return (
    <div style={{ paddingTop: 12, paddingBottom: 13, paddingLeft: 14, paddingRight: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 300, lineHeight: 1.55, color: 'var(--t-text-secondary)', letterSpacing: '-0.1px' }}>
        {explain}
      </p>
      {rows.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, borderRadius: 10, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', overflow: 'hidden' }}>
          {rows.map((row, idx) => (
            <div
              key={row.label}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 12,
                paddingTop: 9,
                paddingBottom: 9,
                paddingLeft: 12,
                paddingRight: 12,
                borderTopWidth: idx === 0 ? 0 : 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle, var(--t-divider))',
                background: idx % 2 === 1 ? 'var(--t-input-bg)' : 'transparent',
              }}
            >
              <span style={{ flexShrink: 0, width: 96, fontSize: 9.5, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
                {row.label}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.005em', lineHeight: 1.45, wordBreak: 'break-word' }}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {event.kind === 'mission-complete' ? <MissionPacketSummary event={event} /> : null}
    </div>
  );
}

type MissionCompleteEvent = Extract<OrchestratorStatusEventData, { kind: 'mission-complete' }>;

interface MissionPacketLine {
  referenceLabel?: string;
  title: string;
  outcome?: string | null;
  summary?: string | null;
  fileCount?: number;
}

/**
 * The "What shipped" section of the mission-complete detail. Lazily fetches a
 * free-AI prose summary of the merged packets (server hydrates each from the
 * session_outcomes ledger) and renders it above an Issues-style list of the
 * packets themselves. Degrades to the packet titles carried on the event if the
 * summary request fails or no OpenRouter key is configured.
 */
function MissionPacketSummary({ event }: { event: MissionCompleteEvent }) {
  const packetsFromEvent = event.packets ?? [];
  const [state, setState] = useState<{
    status: 'idle' | 'loading' | 'done';
    prose: string | null;
    lines: MissionPacketLine[];
  }>({ status: packetsFromEvent.length > 0 ? 'loading' : 'idle', prose: null, lines: [] });

  useEffect(() => {
    const packets = event.packets ?? [];
    if (packets.length === 0) {
      setState({ status: 'idle', prose: null, lines: [] });
      return;
    }
    const controller = new AbortController();
    const fallbackLines: MissionPacketLine[] = packets.map((packet) => ({
      title: packet.title,
      referenceLabel: packet.referenceLabel,
    }));
    setState({ status: 'loading', prose: null, lines: [] });

    void (async () => {
      try {
        const response = await fetch('/api/panel/o8-mission-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: event.repoPath ?? null, summary: event.summary ?? null, packets }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('mission summary request failed');
        const data = await response.json() as { prose?: string | null; packets?: MissionPacketLine[] };
        const lines = Array.isArray(data.packets) && data.packets.length > 0 ? data.packets : fallbackLines;
        setState({ status: 'done', prose: data.prose ?? null, lines });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: 'done', prose: event.summary ?? null, lines: fallbackLines });
      }
    })();

    return () => controller.abort();
  }, [event]);

  if (packetsFromEvent.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
        What shipped
      </span>
      {state.status === 'loading' ? (
        <span style={{ fontSize: 12, fontWeight: 300, color: 'var(--t-text-faint)', letterSpacing: '-0.1px', animation: 'o8StatusDrawerFade 900ms ease-in-out infinite alternate' }}>
          Summarizing the work…
        </span>
      ) : null}
      {state.prose ? (
        <p style={{ margin: 0, fontSize: 12.5, fontWeight: 300, lineHeight: 1.55, color: 'var(--t-text-secondary)', letterSpacing: '-0.1px' }}>
          {state.prose}
        </p>
      ) : null}
      {state.lines.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, borderRadius: 10, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', overflow: 'hidden' }}>
          {state.lines.map((line, idx) => (
            <div
              key={`${line.referenceLabel ?? 'pkt'}-${idx}`}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                paddingTop: 9,
                paddingBottom: 9,
                paddingLeft: 12,
                paddingRight: 12,
                borderTopWidth: idx === 0 ? 0 : 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle, var(--t-divider))',
                background: idx % 2 === 1 ? 'var(--t-input-bg)' : 'transparent',
              }}
            >
              {line.referenceLabel ? (
                <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 400, color: 'var(--t-text-faint)', letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums' }}>
                  {line.referenceLabel}
                </span>
              ) : null}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.005em', lineHeight: 1.4, wordBreak: 'break-word' }}>
                  {line.title}
                </span>
                {line.summary ? (
                  <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-secondary)', letterSpacing: '-0.05px', lineHeight: 1.45, wordBreak: 'break-word' }}>
                    {line.summary}
                  </span>
                ) : null}
                {typeof line.fileCount === 'number' && line.fileCount > 0 ? (
                  <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--t-text-faint)', letterSpacing: '0.02em' }}>
                    {line.fileCount} {line.fileCount === 1 ? 'file' : 'files'} changed
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
