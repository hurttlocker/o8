'use client';

import { useCallback, useEffect, useState, type ComponentProps, type CSSProperties } from 'react';
import {
  addSessionToLayout,
  closeSessionLeaf,
  collectSessionLeaves,
  createDefaultSessionTileLayout,
  resizeSessionSplit,
  type SessionTileLayout,
  type SessionTileLeaf,
} from '@/lib/orchestrator/session-tiles';
import { SessionTileSurface } from './SessionTileSurface';

const WORKERS = [
  { name: 'Cosmo', task: 'Map the handoff path', status: 'Working', note: 'Tracing the request and reply.' },
  { name: 'Atlas', task: 'Verify the message receipt', status: 'Review', note: 'The reply links to the original request.' },
  { name: 'Nova', task: 'Check runtime recovery', status: 'Working', note: 'Checking the latest continuation.' },
  { name: 'Rune', task: 'Audit the split layout', status: 'Needs input', note: 'Ready for a layout decision.' },
  { name: 'Vale', task: 'Inspect the CLI path', status: 'Working', note: 'Comparing the native entry points.' },
  { name: 'Echo', task: 'Check agent identity', status: 'Working', note: 'Mapping names to live sessions.' },
  { name: 'Sage', task: 'Review plugin contracts', status: 'Review', note: 'The first executable pilot is scoped.' },
  { name: 'Orion', task: 'Test approval recovery', status: 'Working', note: 'Following the operator decision.' },
  { name: 'Mira', task: 'Measure first use', status: 'Idle', note: 'Waiting for the next interaction.' },
  { name: 'Kite', task: 'Verify persisted state', status: 'Working', note: 'Comparing the reload result.' },
] as const;

const buttonStyle: CSSProperties = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-border)',
  borderRadius: 8,
  background: 'var(--t-chat-surface-bg, var(--t-panel))',
  color: 'var(--t-text)',
  paddingTop: 5,
  paddingRight: 9,
  paddingBottom: 5,
  paddingLeft: 9,
  fontSize: 11,
  cursor: 'pointer',
};

function MockWorkerPane({
  leaf,
  focused,
  onFocus,
  onClose,
}: {
  leaf: SessionTileLeaf;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const index = Number(leaf.sessionKey?.split(':')[1] ?? 1) - 1;
  const worker = WORKERS[index] ?? WORKERS[0];
  const statusColor = worker.status === 'Needs input'
    ? 'var(--t-warning, #e9a23b)'
    : worker.status === 'Review'
      ? 'var(--t-accent, #688cf2)'
      : worker.status === 'Idle'
        ? 'var(--t-text-faint)'
        : 'var(--t-success, #4ba67a)';

  return (
    <div
      data-preview-worker={leaf.sessionKey}
      onClick={onFocus}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: focused ? 'var(--t-border-hover, var(--t-border))' : 'var(--t-border)',
        borderRadius: 14,
        background: 'var(--t-chat-surface-bg, var(--t-panel))',
        overflow: 'hidden',
      }}
    >
      <div style={{
        height: 36,
        minHeight: 36,
        paddingTop: 0,
        paddingRight: 8,
        paddingBottom: 0,
        paddingLeft: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle, var(--t-border))',
      }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--t-text)' }}>
          @{worker.name} · Codex
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, fontSize: 10, color: 'var(--t-text-secondary)' }}>
          <span style={{ width: 5, height: 5, borderRadius: 999, background: statusColor }} />
          {worker.status}
        </span>
        <button type="button" aria-label={`Close ${worker.name} preview`} onClick={(event) => { event.stopPropagation(); onClose(); }} style={{ border: 0, background: 'transparent', color: 'var(--t-text-secondary)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 }}>
        <div style={{ fontSize: 10, color: 'var(--t-text-faint)', marginBottom: 7 }}>SIMULATED TASK</div>
        <div style={{ color: 'var(--t-text)', fontSize: 13, lineHeight: 1.4, fontWeight: 500 }}>{worker.task}</div>
        <div style={{ marginTop: 18, paddingTop: 11, paddingRight: 12, paddingBottom: 11, paddingLeft: 12, borderRadius: 10, background: 'var(--t-hover)', color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.45 }}>
          {worker.note}
        </div>
      </div>
      <div style={{ paddingTop: 9, paddingRight: 12, paddingBottom: 9, paddingLeft: 12, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider-subtle, var(--t-border))', color: 'var(--t-text-faint)', fontSize: 11 }}>
        Steer this agent…
      </div>
    </div>
  );
}

/** Dev-only visual stress test. Its session keys never enter persistence or the agent registry. */
export function WorkerSplitPreview(live: ComponentProps<typeof SessionTileSurface>) {
  const [request, setRequest] = useState({ count: 0, generation: 0 });
  const [layout, setLayout] = useState<SessionTileLayout>(createDefaultSessionTileLayout);
  const [focusedSessionKey, setFocusedSessionKey] = useState<string | null>(null);
  const active = request.count > 0;

  useEffect(() => {
    if (request.count === 0) return;

    let spawned = 0;
    const timer = window.setInterval(() => {
      spawned += 1;
      const sessionKey = `preview-worker:${spawned}`;
      setLayout((current) => addSessionToLayout(current, sessionKey));
      setFocusedSessionKey(sessionKey);
      if (spawned >= request.count) window.clearInterval(timer);
    }, 180);
    return () => window.clearInterval(timer);
  }, [request]);

  const selectCount = useCallback((count: number) => {
    setLayout(createDefaultSessionTileLayout());
    setFocusedSessionKey(null);
    setRequest((current) => ({ count, generation: current.generation + 1 }));
  }, []);
  const renderSessionPane = useCallback((leaf: SessionTileLeaf) => (
    <MockWorkerPane
      leaf={leaf}
      focused={focusedSessionKey === leaf.sessionKey}
      onFocus={() => setFocusedSessionKey(leaf.sessionKey ?? null)}
      onClose={() => setLayout((current) => closeSessionLeaf(current, leaf.id))}
    />
  ), [focusedSessionKey]);

  return (
    <div data-worker-split-preview={active ? 'true' : undefined} style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {active ? (
        <div style={{ height: 40, minHeight: 40, display: 'flex', alignItems: 'center', gap: 7, paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-border)', color: 'var(--t-text-secondary)', fontSize: 11 }}>
          <span style={{ marginRight: 'auto' }}>Layout preview · {collectSessionLeaves(layout.root).length}/{request.count} simulated workers</span>
          <button type="button" onClick={() => selectCount(4)} style={buttonStyle}>Spawn 4</button>
          <button type="button" onClick={() => selectCount(10)} style={buttonStyle}>Spawn 10</button>
          <button type="button" onClick={() => selectCount(0)} style={buttonStyle}>Live</button>
        </div>
      ) : null}
      <SessionTileSurface
        {...live}
        layout={active ? layout : live.layout}
        focusedSessionKey={active ? focusedSessionKey : live.focusedSessionKey}
        onResizeSplit={active
          ? (splitId, ratio) => setLayout((current) => resizeSessionSplit(current, splitId, ratio))
          : live.onResizeSplit}
        onCloseLeaf={active
          ? (leafId) => setLayout((current) => closeSessionLeaf(current, leafId))
          : live.onCloseLeaf}
        onFocusSession={active ? setFocusedSessionKey : live.onFocusSession}
        renderSessionPane={active ? renderSessionPane : live.renderSessionPane}
      />
      {!active ? (
        <button
          type="button"
          data-worker-split-preview-launch="true"
          onClick={() => selectCount(4)}
          style={{ ...buttonStyle, position: 'absolute', right: 12, bottom: 12, zIndex: 30, boxShadow: '0 4px 18px rgba(0, 0, 0, 0.16)' }}
        >
          Preview 4 / 10 workers
        </button>
      ) : null}
    </div>
  );
}
