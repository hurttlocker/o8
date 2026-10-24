'use client';

import { RamsButton } from '../settings/RamsButton';
import { useEffect, useRef, useState } from 'react';
import { fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { MAX_REPAIR_CHECKS } from '@/lib/github-client/check-repair-prompt';

type Selection = { headSha: string; checks: Array<{ key: string; name: string }> };
type Delegation = { clientMutationId: string; repoPath: string; prompt: string; repairPullRequest: number; expectedRepairHeadSha: string };
type Receipt = { ok?: boolean; code?: string; error?: string; laneId?: string; ownerLaneId?: string; status?: string; outcomeUnknown?: boolean };
const launches = new Map<string, Promise<Receipt>>();
const savedKey = (key: string) => `o8:pr-check-repair:${key}`;
function saved(key: string): Delegation | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(savedKey(key)) ?? 'null') as Delegation | null;
    return value && typeof value.clientMutationId === 'string' && typeof value.repoPath === 'string' && typeof value.prompt === 'string'
      && Number.isSafeInteger(value.repairPullRequest) && typeof value.expectedRepairHeadSha === 'string' ? value : null;
  } catch { return null; }
}
function focus(laneId: string) {
  window.dispatchEvent(new CustomEvent('o8:focus-spawned-agent-lane', { detail: { laneId, title: 'PR check repair' } }));
}

/** Keyed by PR at both production callers, so selection cannot cross PR boundaries. */
export function PrCheckRepair({ repo, number, failed }: { repo: string; number: number; failed: boolean }) {
  const key = `${repo.toLowerCase()}#${number}`;
  const endpoint = `/api/panel/prs/${number}/repair?repo=${encodeURIComponent(repo)}`;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(() => saved(key));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fail = (data: Receipt) => {
    setMessage(data.error ?? 'The repair could not be started. Retry.');
    if (data.code === 'pr_has_owner') { setOwner(data.ownerLaneId ?? null); setSelection(null); }
    if (data.code === 'stale_pr_head' || data.code === 'stale_checks') { setSelection(null); setSelected([]); }
  };
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage(''); setOwner(null);
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const data = await response.json();
      if (!mounted.current) return;
      if (!response.ok || !data.ok) { fail(data); return; }
      setSelection(data); setSelected(data.checks.slice(0, MAX_REPAIR_CHECKS).map((check: { key: string }) => check.key));
      if (!data.checks.length) setMessage('No failed checks remain.');
    } catch { if (mounted.current) setMessage('Checks could not be read. Retry.'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function start() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      let launch = launches.get(key);
      if (!launch) {
        launch = (async (): Promise<Receipt> => {
          let body = saved(key) ?? pending;
          if (!body) {
            if (!selection || !selected.length) return { ok: false, error: 'Select a failed check first.' };
            const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
              expectedHeadSha: selection.headSha, checks: selected, clientMutationId: `pr-repair-${crypto.randomUUID()}`,
            }) });
            const data = await response.json();
            if (!response.ok || !data.ok) return data;
            // Persist before launching. An uncertain result always reuses this exact body.
            body = data.delegation as Delegation;
            sessionStorage.setItem(savedKey(key), JSON.stringify(body));
            if (mounted.current) setPending(body);
          }
          const { response, payload } = await fetchCorrelatedActionReceipt<Receipt>('/api/orchestrator/delegate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          if (!payload || payload.outcomeUnknown) throw new Error('Receipt not settled');
          // A 5xx may have followed a side effect. Preserve the body until proven settled.
          if (response.status >= 500) throw new Error('Receipt unavailable');
          sessionStorage.removeItem(savedKey(key));
          return payload;
        })().finally(() => { launches.delete(key); });
        launches.set(key, launch);
      }
      const result = await launch;
      if (!mounted.current) return;
      setPending(null);
      if (result.ok && result.laneId) { setStarted(result.laneId); setSelection(null); setMessage(result.status === 'pending_approval' ? 'Repair awaits approval.' : 'Repair worker started.'); }
      else fail(result);
    } catch { if (mounted.current) { const retained = saved(key); setPending(retained); setMessage(retained ? 'The repair receipt is unavailable. Check the same request before starting another repair.' : 'Repair preparation failed. Retry before starting a worker.'); } }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  if (!repo || (!failed && !pending && !started)) return null;
  return <div style={{ paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12, fontSize: 12, color: 'var(--t-text)', display: 'grid', gap: 8 }}>
    {!started && !pending ? <RamsButton variant={selection || owner ? 'ghost' : 'primary'} disabled={busy} onClick={() => void refresh()}>{selection || message ? 'Refresh checks' : 'Fix failing checks'}</RamsButton> : null}
    {selection && !pending ? <fieldset disabled={busy} style={{ border: 0, paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }}>
      <legend>Select failed checks (up to {MAX_REPAIR_CHECKS})</legend>
      <p style={{ color: 'var(--t-text-muted)' }}>Starting head {selection.headSha.slice(0, 8)}</p>
      {selection.checks.map(check => <label key={check.key} style={{ display: 'block' }}>
        <input type="checkbox" checked={selected.includes(check.key)} disabled={!selected.includes(check.key) && selected.length >= MAX_REPAIR_CHECKS}
          onChange={event => setSelected(prior => event.target.checked ? [...prior, check.key] : prior.filter(key => key !== check.key))} /> {check.name}
      </label>)}
      <RamsButton disabled={busy || !selected.length} onClick={() => void start()}>Start repair</RamsButton>
    </fieldset> : null}
    {pending ? <RamsButton disabled={busy} onClick={() => void start()}>Check repair receipt</RamsButton> : null}
    {busy ? <span role="status">{pending ? 'Starting repair…' : 'Reading checks and logs…'}</span> : null}
    {message ? <span role="status">{message}</span> : null}
    {owner ? <RamsButton onClick={() => focus(owner)}>Open owning worker</RamsButton> : null}
    {started ? <RamsButton onClick={() => focus(started)}>Open repair worker</RamsButton> : null}
  </div>;
}
