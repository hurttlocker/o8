'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AcpRegistryAgent, AcpRegistryCatalog } from '@/lib/acp/registry';
import type { LocalAcpConnection } from '@/lib/acp/local-connection';
import { RamsButton } from './shared';

export function AcpRegistryPicker({ onChoose, onClose }: { onChoose: (connection: LocalAcpConnection) => void; onClose: () => void }) {
  const [catalog, setCatalog] = useState<AcpRegistryCatalog>();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AcpRegistryAgent>();
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const load = useCallback(async (refresh = false) => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const response = await fetch(`/api/runtime/acp-registry${refresh ? '?refresh=1' : ''}`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.agents)) throw new Error('Agents could not be loaded. Retry or use a local executable.');
      if (!controller.signal.aborted) { setCatalog(data); setSelected(undefined); setNotice(data.stale ? 'Showing a saved catalog. Refresh before preparing an agent.' : ''); }
    } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'Could not load agents.'); }
    finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { searchField.current?.focus(); void load(); return () => request.current?.abort(); }, [load]);
  const prepare = async () => {
    if (!selected?.npm || request.current || catalog?.stale) return;
    const controller = new AbortController(); request.current = controller; setPreparing(true); setNotice('Preparing the package. Your current connection stays active.');
    try {
      const response = await fetch('/api/runtime/acp-registry/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ id: selected.id, fingerprint: selected.fingerprint }) });
      const data = await response.json();
      if (!response.ok || !data.connection) throw new Error(data.error || 'This agent could not be prepared. Retry or use local setup.');
      if (!controller.signal.aborted) onChoose(data.connection);
    } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'Could not prepare the agent.'); }
    finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted) setPreparing(false); }
  };
  const agents = (catalog?.agents ?? []).filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <section aria-label="ACP agent registry" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }} style={{ display: 'grid', gap: 12, marginTop: 12, marginBottom: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <strong>Choose an ACP agent</strong><RamsButton variant="ghost" onClick={onClose}>Close</RamsButton>
    </div>
    <input ref={searchField} aria-label="Search ACP agents" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search agents…"
      style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--t-border)', borderRadius: 8, paddingTop: 10, paddingBottom: 10, paddingLeft: 10, paddingRight: 10, background: 'var(--t-input-bg)', color: 'var(--t-text)' }} />
    <div style={{ maxHeight: 240, overflowY: 'auto', display: 'grid', gap: 4 }}>
      {agents.map(agent => <button key={agent.id} type="button" aria-pressed={selected?.id === agent.id} disabled={preparing} onClick={() => setSelected(agent)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, textAlign: 'left', border: '1px solid var(--t-border)', borderRadius: 8,
          paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, color: 'var(--t-text)', background: selected?.id === agent.id ? 'var(--t-hover)' : 'transparent', cursor: 'pointer' }}>
        <span style={{ minWidth: 0 }}><span style={{ display: 'block', fontWeight: 500 }}>{agent.name}</span><span style={{ display: 'block', marginTop: 3, fontSize: 11, color: 'var(--t-text-muted)' }}>{agent.description}</span></span>
        <span style={{ fontSize: 11, color: 'var(--t-text-muted)', flexShrink: 0 }}>{agent.version}</span>
      </button>)}
      {!loading && catalog && !agents.length ? <span>No matching agents.</span> : null}
    </div>
    {selected ? <div style={{ display: 'grid', gap: 8 }}>
      <strong>{selected.name}</strong>
      {selected.npm ? <><code style={{ overflowWrap: 'anywhere', fontSize: 11 }}>{selected.npm.package}</code>
        <span style={{ color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Prepare downloads this version into o8. It does not start the agent or change your connection. Package setup scripts are disabled.</span>
        <RamsButton variant="primary" busy={preparing} disabled={preparing || catalog?.stale} onClick={() => void prepare()}>Prepare agent</RamsButton></>
        : <span style={{ color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Install this agent using its setup guide, then enter its executable in Local setup.</span>}
      {selected.website ? <a href={selected.website} target="_blank" rel="noreferrer" style={{ color: 'var(--t-accent)' }}>Setup guide</a> : null}
    </div> : null}
    {notice ? <span role="status" style={{ lineHeight: 1.5, color: 'var(--t-text-muted)' }}>{notice}</span> : null}
    <div style={{ display: 'flex', gap: 8 }}><RamsButton variant="ghost" busy={loading} disabled={loading || preparing} onClick={() => void load(true)}>Refresh agents</RamsButton>
      <RamsButton variant="ghost" onClick={onClose}>Local setup</RamsButton></div>
  </section>;
}
