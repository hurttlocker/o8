'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import type { TaskDraftContract } from '@/lib/mcp/task-draft-contract';
import type { executionReceipt } from '@/lib/mcp/task-execution-store';
import { APP_FONT_STACK, MONO_FONT_STACK, RamsButton } from '../shared';
import { SettingsGroup } from '../grouped';

type Execution = ReturnType<typeof executionReceipt>;
interface Draft {
  taskId: string;
  contractHash: string;
  sessionCurrent: boolean;
  contract: TaskDraftContract;
  revision: string;
  rulesDigest: string;
  execution: Execution | null;
  executionError: string | null;
}
interface StopHandle { accountId: string; taskId: string; contractHash: string }
const rowStyle = { paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14,
  fontFamily: APP_FONT_STACK, fontSize: 13, fontWeight: 300, color: 'var(--t-text)', lineHeight: 1.5 };

export function PluginTaskReview() {
  const auth = useO8Auth();
  const accountId = auth.isLoaded && auth.signedIn ? auth.user?.id ?? null : null;
  const identity = useRef({ accountId, generation: 0 });
  if (identity.current.accountId !== accountId) {
    identity.current = { accountId, generation: identity.current.generation + 1 };
  }
  const [loaded, setLoaded] = useState<{ generation: number; drafts: Draft[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ generation: number; text: string } | null>(null);
  const [uncertain, setUncertain] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [stopHandle, setStopHandle] = useState<StopHandle | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const serial = useRef(0);
  const visible = loaded?.generation === identity.current.generation ? loaded.drafts : [];
  const draft = visible.find((entry) => entry.taskId === selected) ?? visible[0];
  const safeStop = stopHandle && (!accountId || stopHandle.accountId === accountId) ? stopHandle : null;

  const load = useCallback(async () => {
    const captured = { ...identity.current };
    if (!captured.accountId) return;
    const sequence = ++serial.current;
    setBusy('Reading held tasks');
    try {
      const response = await fetch('/api/plugins/task-drafts', { cache: 'no-store' });
      const body = await response.json();
      if (captured.generation !== identity.current.generation || sequence !== serial.current) return;
      if (!response.ok || body.ok !== true || body.accountId !== captured.accountId || !Array.isArray(body.drafts)) {
        throw new Error('Tasks are held. Sign in to the same o8 account and refresh.');
      }
      setLoaded({ generation: captured.generation, drafts: body.drafts });
      setMessage(null);
    } catch (error) {
      if (captured.generation !== identity.current.generation || sequence !== serial.current) return;
      setLoaded(null);
      setMessage({ generation: captured.generation, text: error instanceof Error ? error.message : 'Could not read tasks.' });
    } finally {
      if (captured.generation === identity.current.generation && sequence === serial.current) setBusy(null);
    }
  }, []);

  useEffect(() => {
    const requests = serial;
    ++serial.current;
    setLoaded(null);
    setBusy(null);
    setMessage(null);
    setSelected(null);
    setConfirmStop(false);
    setStopHandle((previous) => accountId && previous?.accountId !== accountId ? null : previous);
    void load();
    return () => { ++requests.current; };
  }, [accountId, load]);

  useEffect(() => {
    if (draft?.execution && accountId && !draft.execution.stopped && !draft.execution.completed) {
      setStopHandle({ accountId, taskId: draft.taskId, contractHash: draft.contractHash });
    } else if (draft?.execution?.stopped || draft?.execution?.completed) {
      setStopHandle((previous) => previous?.taskId === draft.taskId ? null : previous);
    }
  }, [accountId, draft]);

  const control = async (action: 'launch' | 'inspect' | 'stop', target: StopHandle) => {
    const captured = { ...identity.current };
    if (busy || (action !== 'stop' && captured.accountId !== target.accountId)) return;
    const sequence = ++serial.current;
    setBusy(action === 'launch' ? 'Checking and starting the reviewed attempt' : action === 'stop' ? 'Stopping the attempt' : 'Inspecting the persisted attempt');
    setConfirmStop(false);
    if (action === 'launch') {
      setUncertain((previous) => new Set(previous).add(target.taskId));
      setStopHandle(target);
    }
    try {
      const response = await fetch('/api/plugins/task-drafts/control', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, taskId: target.taskId, contractHash: target.contractHash }) });
      const body = await response.json();
      if (captured.generation !== identity.current.generation || sequence !== serial.current) return;
      const execution = body.execution as Execution | undefined;
      if (!response.ok || body.ok !== true || execution?.taskId !== target.taskId || execution.contractHash !== target.contractHash) {
        throw new Error('The outcome is held or uncertain. Inspect this task before taking another action.');
      }
      setLoaded((previous) => previous && previous.generation === captured.generation
        ? { ...previous, drafts: previous.drafts.map((entry) => entry.taskId === target.taskId ? { ...entry, execution, executionError: null } : entry) } : previous);
      setMessage({ generation: captured.generation, text: `Attempt ${execution.attemptId}: ${execution.state}. Review the worker evidence before using its result.` });
      if (execution.stopped || execution.completed) setStopHandle(null);
      else setStopHandle(target);
    } catch (error) {
      if (captured.generation !== identity.current.generation || sequence !== serial.current) return;
      setMessage({ generation: captured.generation, text: error instanceof Error ? error.message : 'Inspect this task. The outcome is uncertain.' });
    } finally {
      if (captured.generation === identity.current.generation && sequence === serial.current) setBusy(null);
    }
  };
  const target = draft && accountId ? { accountId, taskId: draft.taskId, contractHash: draft.contractHash } : null;
  const hasAttempt = Boolean(draft?.execution || draft?.executionError || (draft && uncertain.has(draft.taskId)));
  const canLaunch = Boolean(target && draft?.sessionCurrent && !hasAttempt && !busy);
  const stopTarget = target && draft?.execution && !draft.execution.stopped && !draft.execution.completed
    ? target : draft ? (!draft.execution && safeStop?.taskId === draft.taskId ? safeStop : null) : safeStop;

  return (
    <section style={{ marginBottom: 28 }} aria-label="ChatGPT task review">
      <SettingsGroup header="ChatGPT tasks" footnote="ChatGPT can prepare a task. This desktop starts one worker only after you review and launch it. Worker usage belongs to the selected provider; savings have not been measured.">
        <div style={rowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span>Review held tasks</span>
            <RamsButton variant="ghost" disabled={!accountId || Boolean(busy)} onClick={() => { void load(); }}>Refresh</RamsButton>
          </div>
          {!accountId ? <p>Sign in to o8 to review tasks for your account.</p> : null}
          {accountId && !draft && !busy ? <p>No held tasks are available for this account.</p> : null}
          {visible.length > 1 ? <select aria-label="Held task" disabled={Boolean(busy)} value={draft?.taskId} onChange={(event) => { setSelected(event.target.value); setConfirmStop(false); }}
            style={{ width: '100%', background: 'var(--t-bg-card)', color: 'var(--t-text)', marginTop: 12 }}>
            {visible.map((entry) => <option key={entry.taskId} value={entry.taskId}>{entry.contract.objective}</option>)}
          </select> : null}
          {draft && target ? <>
            <p>{draft.contract.objective}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <RamsButton disabled={!canLaunch} onClick={() => { void control('launch', target); }}>Launch reviewed task</RamsButton>
              <RamsButton variant="ghost" disabled={Boolean(busy) || !draft.sessionCurrent || !hasAttempt} onClick={() => { void control('inspect', target); }}>Inspect attempt</RamsButton>
            </div>
            <p>Read only. One attempt. No automatic retry, fallback, setup, or mission replacement. Review is required.</p>
            <p>{draft.contract.runtime} · {draft.contract.model} · {draft.contract.provider ? 'OpenRouter API · provider default reasoning' : `${draft.contract.effort} effort · native provider login`}</p>
            {draft.contract.provider ? <p>Up to {draft.contract.provider.maxRequests} model requests, {draft.contract.provider.maxOutputTokens.toLocaleString()} output tokens per request and 90 seconds. Stops after reported cost reaches ${draft.contract.provider.costUsd.toFixed(2)}; the last request can exceed that amount. Unknown cost holds further requests.</p> : null}
            <p>Computer: {draft.contract.machineId}<br />Project: {draft.contract.projectId}<br />Repository: {draft.contract.repoId}</p>
            <p>Allowed files: {draft.contract.allowedFiles.join(', ')}</p>
            <p>Acceptance evidence: {draft.contract.evidence.join('; ')}</p>
            {!draft.sessionCurrent ? <p>This task belongs to an earlier sign-in. Launch is held.</p> : null}
            <p style={{ overflowWrap: 'anywhere', fontFamily: MONO_FONT_STACK, fontSize: 11 }}>
              Task: {draft.taskId}<br />Contract: {draft.contractHash}<br />Revision: {draft.revision}<br />Rules: {draft.rulesDigest}
              {draft.execution ? <><br />Attempt: {draft.execution.attemptId} · {draft.execution.state}</> : null}
            </p>
            <details><summary>Exact task requirements</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11 }}>{JSON.stringify(draft.contract.sealedTaskContract, null, 2)}</pre></details>
          </> : null}
          {stopTarget ? <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <span style={{ overflowWrap: 'anywhere', fontSize: 11 }}>Task {stopTarget.taskId}</span>
            {confirmStop ? <>
              <span>Stop this attempt?</span>
              <RamsButton variant="danger" disabled={Boolean(busy)} onClick={() => { void control('stop', stopTarget); }}>Stop attempt</RamsButton>
              <RamsButton variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirmStop(false)}>Cancel</RamsButton>
            </> : <RamsButton variant="danger" disabled={Boolean(busy)} onClick={() => setConfirmStop(true)}>Stop worker</RamsButton>}
          </div> : null}
          <div role="status" aria-live="polite" style={{ marginTop: 8, color: 'var(--t-text-muted)' }}>
            {busy ?? (message?.generation === identity.current.generation ? message.text : null)}
          </div>
        </div>
      </SettingsGroup>
    </section>
  );
}
