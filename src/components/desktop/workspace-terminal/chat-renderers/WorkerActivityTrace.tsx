'use client';

import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ActivityBlock, ActivityStep } from '../worker-activity';

function subscribeMotion(change: () => void) {
  if (!window.matchMedia) return () => {};
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}
const motionReduced = () => !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const serverReduced = () => true;

const mono = 'var(--font-mono-system), monospace';
const chip: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, maxWidth: '100%',
  paddingLeft: 6, paddingRight: 6, borderRadius: 5, background: 'var(--t-hover)', color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 };

export function ActivityFileChip({ path }: { path: string }) {
  return <span title={path} style={chip}>
    <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ flexShrink: 0 }}>
      <path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3" />
    </svg>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path.split('/').pop()}</span>
  </span>;
}

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
}

function TraceStep({ step, live }: { step: ActivityStep; live: boolean }) {
  const reduced = useSyncExternalStore(subscribeMotion, motionReduced, serverReduced);
  const running = live && step.status === 'running';
  const singleName = step.files.length === 1 ? step.files[0].split('/').pop() : null;
  const files = singleName && [step.label, step.liveLabel].some(label => label.endsWith(` ${singleName}`)) ? [] : step.files;
  return <li data-activity-step={step.status} style={{ position: 'relative', listStyle: 'none', minWidth: 0, paddingLeft: 18, paddingTop: 5, paddingBottom: 5 }}>
    <span aria-label={step.status} style={{ position: 'absolute', left: -3, top: 13, width: 5, height: 5, borderRadius: '50%',
      background: step.status === 'failed' ? 'var(--t-tone-fail)' : running ? 'var(--t-text)' : 'var(--t-text-faint)',
      animation: running && !reduced ? 'o8-text-shimmer 1.9s ease-in-out infinite' : 'none' }} />
    <details>
      <summary data-activity-label title={step.command} style={{ display: 'block', listStyle: 'none', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300, lineHeight: '18px',
        color: running ? 'var(--t-text)' : step.status === 'failed' || step.status === 'stopped' ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
        animation: running && !reduced ? 'o8-text-shimmer 1.9s ease-in-out infinite' : 'none' }}>
        {running ? step.liveLabel : step.label}
      </summary>
      <code data-activity-command title={step.command} style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontFamily: mono, fontSize: 11, lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.command}</code>
    </details>
    {step.reason ? <div title={step.reason} style={{ color: 'var(--t-text-faint)', fontSize: 11, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{step.reason}</div> : null}
    {files.length ? <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
      {files.slice(0, 4).map(path => <ActivityFileChip key={path} path={path} />)}
      {files.length > 4 ? <span title={files.slice(4).join('\n')} style={{ ...chip, background: 'transparent' }}>+{files.length - 4} more</span> : null}
    </div> : null}
  </li>;
}

export function WorkerActivityTrace({ block }: { block: ActivityBlock }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const id = useId();
  useEffect(() => {
    if (!block.live || block.startedAt == null) return;
    const firstTick = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearTimeout(firstTick); window.clearInterval(timer); };
  }, [block.live, block.startedAt]);
  const open = block.live || expanded;
  const end = block.live ? now ?? block.startedAt : block.finishedAt;
  const elapsed = block.startedAt != null && end != null && (block.live || end > block.startedAt) ? duration(end - block.startedAt) : null;
  const liveStep = [...block.steps].reverse().find(step => step.status === 'running');
  const label = block.live ? `Working${elapsed ? ` ${elapsed}` : ''}` : elapsed ? `Worked for ${elapsed}` : 'Work details';
  return <div data-worker-trace style={{ minWidth: 0, width: '100%' }}>
    <button type="button" disabled={block.live} aria-expanded={open} aria-controls={id} onClick={() => setExpanded(value => !value)}
      title={[label, block.summary, block.failed ? `${block.failed} command${block.failed === 1 ? '' : 's'} failed` : ''].filter(Boolean).join(' · ')}
      style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', minHeight: 28, textAlign: 'left',
        border: 0, padding: 0, background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'inherit', fontSize: 12, fontWeight: 300, lineHeight: 1.5, cursor: block.live ? 'default' : 'pointer' }}>
      <span style={{ flexShrink: 0 }}>{label}</span><span aria-hidden="true">·</span>
      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.live && liveStep ? liveStep.liveLabel : block.summary}</span>
      {block.failed ? <span style={{ color: 'var(--t-tone-fail)', flexShrink: 0, whiteSpace: 'nowrap' }}>· {block.failed} command{block.failed === 1 ? '' : 's'} failed</span> : null}
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" style={{ flexShrink: 0, alignSelf: 'center', transform: open ? 'rotate(90deg)' : undefined }}><path d="m4 2 4 4-4 4" /></svg>
    </button>
    {open ? <ol id={id} style={{ marginTop: 2, marginRight: 0, marginBottom: 4, marginLeft: 4, padding: 0, borderLeft: '1px solid var(--t-divider-subtle)' }}>
      {block.steps.map(step => <TraceStep key={step.id} step={step} live={block.live} />)}
    </ol> : null}
  </div>;
}
