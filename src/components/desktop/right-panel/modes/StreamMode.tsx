'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewChangedFile } from '@/lib/fleet/types';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const MONO = 'var(--font-mono, "SF Mono", Menlo, monospace)';

interface TranscriptResponse {
  events?: TranscriptEvent[];
  error?: { message?: string };
}

interface ReviewResponse {
  changedFiles?: ReviewChangedFile[];
}

interface TranscriptState {
  packetId: string | null;
  events: TranscriptEvent[];
  error: string | null;
}

interface FileState {
  repoPath: string | null;
  files: ReviewChangedFile[];
}

type StreamItem =
  | { id: string; kind: 'assistant'; label: string; body: string; ts: number }
  | { id: string; kind: 'tool'; label: string; body: string; ts: number; ok?: boolean }
  | { id: string; kind: 'file'; label: string; body: string; ts: number; additions: number; deletions: number };

function clip(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

function tsMs(raw: string): number {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

export function StreamMode({ packet, repoPath }: { packet: OrchestratorPacket | null; repoPath: string | null }) {
  const [transcriptState, setTranscriptState] = useState<TranscriptState>({
    packetId: null,
    events: [],
    error: null,
  });
  const [fileState, setFileState] = useState<FileState>({ repoPath: null, files: [] });
  const [pinnedTop, setPinnedTop] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!packet) return;
    let cancelled = false;
    const load = () => {
      fetch(`/api/orchestrator/packet-transcript?packetId=${encodeURIComponent(packet.id)}&tail=1&limit=40`, {
        credentials: 'same-origin',
      })
        .then(async (response) => {
          const payload = await response.json().catch(() => null) as TranscriptResponse | null;
          if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
          return payload ?? {};
        })
        .then((payload) => {
          if (cancelled) return;
          setTranscriptState({
            packetId: packet.id,
            events: Array.isArray(payload.events) ? payload.events : [],
            error: null,
          });
        })
        .catch((err) => {
          if (cancelled) return;
          setTranscriptState({
            packetId: packet.id,
            events: [],
            error: err instanceof Error ? err.message : 'Unable to load stream.',
          });
        });
    };
    const initialTimer = window.setTimeout(load, 0);
    const timer = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [packet]);

  useEffect(() => {
    if (!packet || !repoPath) return;
    let cancelled = false;
    const load = () => {
      fetch(`/api/review/workspace?workspace=${encodeURIComponent(repoPath)}`, { credentials: 'same-origin' })
        .then((response) => response.json())
        .then((payload: ReviewResponse) => {
          if (!cancelled) {
            setFileState({
              repoPath,
              files: Array.isArray(payload.changedFiles) ? payload.changedFiles : [],
            });
          }
        })
        .catch(() => {
          if (!cancelled) setFileState({ repoPath, files: [] });
        });
    };
    const initialTimer = window.setTimeout(load, 0);
    const timer = window.setInterval(load, 6000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [packet, repoPath]);

  const items = useMemo<StreamItem[]>(() => {
    const events = transcriptState.packetId === packet?.id ? transcriptState.events : [];
    const files = fileState.repoPath === repoPath ? fileState.files : [];
    const eventItems = events.flatMap<StreamItem>((event) => {
      if (event.type === 'assistant') {
        return [{
          id: `assistant:${event.seq}`,
          kind: 'assistant',
          label: 'assistant',
          body: clip(event.text, 120),
          ts: tsMs(event.ts),
        }];
      }
      if (event.type === 'tool_call' || event.type === 'tool_result') {
        return [{
          id: `${event.type}:${event.seq}`,
          kind: 'tool',
          label: event.tool,
          body: clip(event.type === 'tool_call' ? event.summary || event.args : event.summary, 60),
          ts: tsMs(event.ts),
          ok: event.type === 'tool_result' ? event.ok : undefined,
        }];
      }
      return [];
    });
    const fileItems = files.slice(0, 8).map<StreamItem>((file, index) => ({
      id: `file:${file.path}:${index}`,
      kind: 'file',
      label: file.path,
      body: `${file.status} · +${file.additions ?? 0} -${file.deletions ?? 0}`,
      ts: 0,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    }));
    return [...eventItems, ...fileItems].sort((a, b) => b.ts - a.ts);
  }, [fileState.files, fileState.repoPath, packet?.id, repoPath, transcriptState.events, transcriptState.packetId]);

  const itemSignature = items.map((item) => item.id).join('|');
  useEffect(() => {
    if (!pinnedTop) return;
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    });
  }, [itemSignature, pinnedTop]);

  const error = transcriptState.packetId === packet?.id ? transcriptState.error : null;

  if (!packet || (items.length === 0 && !error)) {
    return <StreamEmpty />;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        setPinnedTop(event.currentTarget.scrollTop < 8);
      }}
      style={{
        height: '100%',
        overflowY: 'auto',
        paddingTop: 8,
        paddingRight: 8,
        paddingBottom: 10,
        paddingLeft: 8,
      }}
    >
      {error ? (
        <StreamNotice text={`[STREAM] · ${error}`} />
      ) : null}
      {items.map((item) => <StreamRow key={item.id} item={item} />)}
    </div>
  );
}

function StreamEmpty() {
  return <StreamNotice text="[STREAM] · agent idle · waiting for first turn" />;
}

function StreamNotice({ text }: { text: string }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 16,
        paddingBottom: 24,
        paddingLeft: 16,
        color: 'var(--t-text-muted)',
        fontSize: 12,
        letterSpacing: '-0.01em',
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  );
}

function StreamRow({ item }: { item: StreamItem }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 9,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        paddingTop: 9,
        paddingRight: 6,
        paddingBottom: 9,
        paddingLeft: 6,
      }}
    >
      <StreamGlyph kind={item.kind} ok={item.kind === 'tool' ? item.ok : undefined} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          title={item.label}
          style={{
            color: 'var(--t-text)',
            fontSize: 11.5,
            fontWeight: 500,
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.label}
        </div>
        <div
          style={{
            marginTop: 3,
            color: 'var(--t-text-muted)',
            fontSize: 11,
            lineHeight: 1.45,
            letterSpacing: '-0.01em',
            fontFamily: item.kind === 'assistant' ? undefined : MONO,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.body}
        </div>
      </div>
      {item.kind === 'file' ? (
        <span
          style={{
            flexShrink: 0,
            fontFamily: MONO,
            fontSize: 10,
            color: 'var(--t-text-muted)',
            paddingTop: 1,
          }}
        >
          +{item.additions} -{item.deletions}
        </span>
      ) : null}
    </div>
  );
}

function StreamGlyph({ kind, ok }: { kind: StreamItem['kind']; ok?: boolean }) {
  const color = kind === 'assistant'
    ? 'var(--t-brand-orange, #FF5A1F)'
    : kind === 'file'
      ? 'var(--t-text-muted)'
      : ok === false
        ? 'var(--t-brand-red, #ef4444)'
        : 'var(--t-text-muted)';
  return (
    <span
      style={{
        width: 18,
        height: 18,
        borderRadius: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color,
        background: 'var(--t-input-bg)',
      }}
    >
      <svg width={12} height={12} viewBox="0 0 256 256" fill="currentColor" aria-hidden style={{ display: 'block', flexShrink: 0 }}>
        {kind === 'assistant' ? (
          <path d="M224,128a96,96,0,1,1-96-96A96.11,96.11,0,0,1,224,128ZM96,112a12,12,0,1,0-12,12A12,12,0,0,0,96,112Zm88,0a12,12,0,1,0-12,12A12,12,0,0,0,184,112Zm-40,48H112a8,8,0,0,0,0,16h32a8,8,0,0,0,0-16Z" />
        ) : kind === 'file' ? (
          <path d="M208,88H152V32a8,8,0,0,0-16,0V96a8,8,0,0,0,8,8h64a8,8,0,0,0,0-16Zm-16,32a8,8,0,0,0-8,8v64H72V64h40a8,8,0,0,0,0-16H64A8,8,0,0,0,56,56V200a8,8,0,0,0,8,8H192a8,8,0,0,0,8-8V128A8,8,0,0,0,192,120Z" />
        ) : (
          <path d="M229.66,77.66l-51.32-51.32a8,8,0,0,0-11.32,0L138.34,55,201,117.66l28.68-28.68A8,8,0,0,0,229.66,77.66ZM88,105.37,37.66,155.72a8,8,0,0,0-2.1,3.68l-13.33,53.31a8,8,0,0,0,9.7,9.7l53.31-13.33a8,8,0,0,0,3.68-2.1L139.27,156.63Z" />
        )}
      </svg>
    </span>
  );
}
