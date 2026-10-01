'use client';

import { useMemo, useState } from 'react';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { useProjects } from '../repo-registry/useProjects';
import { useOrchestratorData } from '../orchestrator-data-context';
import { AgentStatusDot, agentStatusToDotState } from '../AgentStatusDot';
import { NewTaskComposer } from '../repo-focus/tabs/control-room/NewTaskComposer';
import { createTaskRequest, type TaskExecutionRuntime } from '../repo-focus/tabs/control-room/create-task-request';
import { taskTimeLabel } from '../repo-focus/tabs/control-room/helpers';
import type { TaskAction, TaskMutationPayload, TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import { THREAD_GROUPS, resolveThreadProject, scopeThreadAgents, scopeThreads, threadModelLabel, threadStatusLine } from './threads-model';
import { useThreadsTasks } from './useThreadsTasks';
import { useThreadRepos } from './useThreadRepos';
import { ThreadDetail } from './ThreadDetail';
import { ThreadActions, ThreadActionButton } from './ThreadActions';

const smallButtonStyle: React.CSSProperties = { height: 26, border: 0, borderRadius: 7, paddingLeft: 9, paddingRight: 9, fontSize: 12, fontWeight: 300, fontFamily: 'inherit', letterSpacing: '-0.1px', cursor: 'pointer', color: 'var(--t-text-muted)', background: 'transparent' };

export function O8ThreadsPane({ active, repoPath, repos, allRepos = false, initialView = 'threads' }: {
  active: boolean;
  repoPath: string | null;
  repos: RepoRegistryEntry[];
  allRepos?: boolean;
  initialView?: 'threads' | 'agents';
}) {
  const context = useOrchestratorData();
  const projects = useProjects();
  const project = resolveThreadProject(projects.ledger?.projects ?? [], projects.activeProject, repoPath, allRepos);
  const paths = useMemo(() => allRepos ? repos.map((repo) => repo.localPath) : repoPath ? [repoPath] : [], [allRepos, repos, repoPath]);
  const scope = useMemo(() => ({ projectId: project?.id ?? null, repoPaths: paths }), [paths, project?.id]);
  const scopeKey = JSON.stringify(scope);
  const pool = useThreadsTasks(active && !projects.loading, scopeKey);
  const registeredRepos = useThreadRepos(active, repoPath, repos);
  const tasks = useMemo(() => scopeThreads(pool.tasks, scope), [pool.tasks, scope]);
  const agents = useMemo(() => scopeThreadAgents(context?.agents ?? [], tasks, scope), [context?.agents, scope, tasks]);
  const [view, setView] = useState(initialView);
  const [selection, setSelection] = useState<{ scopeKey: string; id: string } | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>(['done']);
  const [composerOpen, setComposerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [targetRepo, setTargetRepo] = useState(repoPath ?? repos[0]?.localPath ?? '');
  const [intent, setIntent] = useState('heavy_worker');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ scopeKey: string; task: TaskPoolTask; action: TaskAction; body?: Record<string, unknown> } | null>(null);
  const selected = selection?.scopeKey === scopeKey ? tasks.find((task) => task.id === selection.id) : null;
  const waiting = tasks.filter((task) => task.group === 'blocked').length;
  const working = tasks.filter((task) => task.group === 'running').length;
  const resolved = tasks.filter((task) => task.group === 'done').length;
  const currentTargetRepo = paths.includes(targetRepo) ? targetRepo : paths[0] ?? '';
  const availableRepos = registeredRepos.filter((repo) => paths.includes(repo.localPath));
  const canCreate = Boolean(project && currentTargetRepo && availableRepos.some((repo) => repo.localPath === currentTargetRepo));

  const create = async (dispatch: boolean, runtime: TaskExecutionRuntime, model: string | null, effort: ThinkingEffort | null) => {
    if (busyKey || !project || !canCreate) return;
    setBusyKey('create');
    setNotice(dispatch ? 'Creating and dispatching this thread…' : 'Creating this thread…');
    try {
      const result = await createTaskRequest({ title: title.trim(), summary: summary.trim() || null, projectId: project.id, repoPath: currentTargetRepo, workerIntent: intent, requestedRuntime: runtime, model, requestedEffort: effort }, dispatch);
      setNotice(result);
      setTitle(''); setSummary(''); setComposerOpen(false);
      pool.refresh();
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Unable to create this thread.'); }
    finally { setBusyKey(null); }
  };

  const mutate = async (task: TaskPoolTask, action: TaskAction, body?: Record<string, unknown>) => {
    if (busyKey) return false;
    setBusyKey(`${action}:${task.id}`);
    setNotice('Updating this thread…');
    try {
      const response = await ipcFetch(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'orchestrator', projectId: task.project?.id ?? scope.projectId, repoPath: task.repoPath, ...body }) });
      const payload = await response.json() as Partial<TaskMutationPayload> & { error?: string };
      if (!response.ok || payload.ok === false) throw new Error(payload.error || payload.note || 'Unable to update this thread.');
      setNotice(payload.note || 'Thread updated.');
      pool.refresh();
      return true;
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Unable to update this thread.'); return false; }
    finally { setBusyKey(null); }
  };

  const actOnThread = (task: TaskPoolTask, action: TaskAction, body?: Record<string, unknown>) => {
    if (action === 'archive' || action === 'prune' || action === 'remove') setConfirmation({ scopeKey, task, action, body });
    else void mutate(task, action, body);
  };

  return (
    <div aria-label="Project threads panel" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-sans-system)', color: 'var(--t-text)', background: 'transparent' }}>
      <div role="tablist" aria-label="Thread panel views" style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)' }}>
        {(['threads', 'agents'] as const).map((tab) => <button key={tab} role="tab" aria-selected={view === tab} onClick={() => { setView(tab); if (tab === 'threads') setSelection(null); }} style={{ ...smallButtonStyle, background: view === tab ? 'var(--t-input-bg)' : 'transparent', color: view === tab ? 'var(--t-text)' : 'var(--t-text-muted)' }}>{tab === 'threads' ? 'Threads' : 'Agents'}</button>)}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={pool.refresh} disabled={pool.loading} style={smallButtonStyle}>Refresh</button>
        <button type="button" aria-label="Create thread" disabled={!canCreate || Boolean(busyKey)} onClick={() => { setView('threads'); setSelection(null); setComposerOpen((open) => !open); }} style={smallButtonStyle}>+</button>
      </div>
      {notice ? <div role="status" style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, fontSize: 11, fontWeight: 300, lineHeight: 1.4, color: 'var(--t-text-muted)' }}>{notice}</div> : null}
      {pool.error ? <div role="alert" style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, fontSize: 12 }}>{pool.error}</div> : null}
      {view === 'threads' && selected ? <ThreadDetail key={`detail:${scopeKey}:${selected.id}`} task={selected} active={active} evidenceRevision={pool.evidenceRevision} onBack={() => setSelection(null)} actions={<ThreadActions task={selected} busy={Boolean(busyKey)} onSelectSession={context?.onSelectSession} onAction={actOnThread} />} /> : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 }}>
          {view === 'threads' ? <>
            <div style={{ fontSize: 18, fontWeight: 400, letterSpacing: '-0.2px', lineHeight: 1.25 }}>{project?.name || repoPath?.split('/').filter(Boolean).pop() || 'Your threads'}</div>
            <div style={{ marginTop: 6, marginBottom: 20, fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)' }}>{projects.loading || pool.loading && !tasks.length ? 'Reading project threads…' : waiting ? `${waiting} thread${waiting === 1 ? ' is' : 's are'} waiting on you.` : 'Nothing is waiting on you.'}</div>
            {composerOpen && canCreate ? <NewTaskComposer repos={availableRepos} selectedRepo={availableRepos.find((repo) => repo.localPath === repoPath)} title={title} summary={summary} repoPath={currentTargetRepo} workerIntent={intent} busy={busyKey === 'create'} onTitleChange={setTitle} onSummaryChange={setSummary} onRepoPathChange={setTargetRepo} onWorkerIntentChange={setIntent} onCancel={() => setComposerOpen(false)} onCreate={(runtime, model, effort) => { void create(false, runtime, model, effort); }} onCreateAndDispatch={(runtime, model, effort) => { void create(true, runtime, model, effort); }} /> : null}
            {pool.loading && !tasks.length ? <p style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Reading project threads…</p> : null}
            {!pool.loading && !pool.error && !tasks.length ? <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Start a thread here or dispatch work from your conversation. Local and remote workers appear here with their recorded status.</p> : null}
            {THREAD_GROUPS.map((group) => {
              const entries = tasks.filter((task) => task.group === group.id);
              if (!entries.length) return null;
              const open = !collapsed.includes(group.id);
              return <section key={group.id} style={{ marginTop: 14 }}>
                <button type="button" aria-expanded={open} onClick={() => setCollapsed((current) => open ? [...current, group.id] : current.filter((id) => id !== group.id))} style={{ ...smallButtonStyle, width: '100%', textAlign: 'left', height: 30, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--t-hover)' }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: open ? 'rotate(90deg)' : undefined }}><path d="m9 5 7 7-7 7" /></svg>
                  <span style={{ flex: 1 }}>{group.label}</span><span style={{ color: 'var(--t-text-faint)' }}>{entries.length}</span>
                </button>
                {open ? entries.map((task) => <button key={task.id} type="button" aria-label={`View thread ${task.title}`} onClick={() => setSelection({ scopeKey, id: task.id })} style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'flex-start', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text)', textAlign: 'left', paddingTop: 12, paddingRight: 8, paddingBottom: 12, paddingLeft: 8, fontFamily: 'inherit', cursor: 'pointer' }} onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }} onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ paddingTop: 3 }}><AgentStatusDot state={agentStatusToDotState(task.status)} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>{task.title}</span>
                    <span style={{ display: 'block', marginTop: 4, fontSize: 12, lineHeight: 1.4, fontWeight: 300, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{threadStatusLine(task)}</span>
                    <span style={{ display: 'block', marginTop: 4, fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>{threadModelLabel(task)}</span>
                  </span>
                  <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)', whiteSpace: 'nowrap', paddingTop: 2 }}>{taskTimeLabel(task)}</span>
                </button>) : null}
              </section>;
            })}
          </> : <>
            <div style={{ fontSize: 18, fontWeight: 400 }}>Agents in this scope</div>
            <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Live workers and their recorded models.</p>
            {agents.map((agent) => <div key={agent.sessionKey || agent.name} style={{ display: 'flex', gap: 10, borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 12, paddingBottom: 12 }}>
              <AgentStatusDot state={agentStatusToDotState(agent.status)} />
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13.5, fontWeight: 300 }}>{agent.name || agent.currentTask || 'Worker'}</div><div style={{ marginTop: 4, fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-faint)' }}>{[agent.runtime, agent.model, agent.status].filter(Boolean).join(' · ')}</div>{agent.activity?.headline ? <p style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--t-text-muted)' }}>{agent.activity.headline}</p> : null}</div>
            </div>)}
            {!agents.length ? <p style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No live agents recorded in this scope.</p> : null}
          </>}
        </div>
      )}
      {confirmation?.scopeKey === scopeKey ? <div role="group" aria-label="Confirm thread action" style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, borderTop: '1px solid var(--t-divider-subtle)', fontSize: 12 }}>
        <p style={{ marginTop: 0 }}>{confirmation.action === 'prune' ? 'Permanently prune' : confirmation.action === 'archive' ? 'Archive' : 'Un-queue'} “{confirmation.task.title}”?</p>
        <div style={{ display: 'flex', gap: 8 }}><ThreadActionButton label="Cancel" disabled={Boolean(busyKey)} onClick={() => setConfirmation(null)} /><ThreadActionButton label={busyKey ? 'Updating…' : confirmation.action === 'prune' ? 'Prune permanently' : confirmation.action === 'archive' ? 'Archive thread' : 'Un-queue thread'} danger={confirmation.action === 'prune'} disabled={Boolean(busyKey)} onClick={() => { void mutate(confirmation.task, confirmation.action, confirmation.body).then((ok) => { if (ok) setConfirmation(null); }); }} /></div>
      </div> : null}
      <div style={{ display: 'flex', gap: 12, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, fontSize: 10, fontWeight: 260, color: 'var(--t-text-faint)', borderTop: '1px solid var(--t-divider-subtle)' }}><span>{working} working</span><span>{resolved} resolved</span><span style={{ marginLeft: 'auto' }}>{tasks.length} threads</span></div>
    </div>
  );
}
