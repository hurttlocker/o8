'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ActionRepositoryPicker, type ActionRepository } from './ActionRepositoryPicker';

type PluginAction = { id: string; description: string; entry: string; args: string[]; timeoutMs: number };
type Manifest = { id: string; name: string; version: string; description: string; supportedPlatforms: string[]; workspace: 'none' | 'registered-project'; actions: PluginAction[] };
type Review = { manifest: Manifest; revision: string; files: Array<{ path: string; bytes: number; sha256: string; content: string }>; execution: { cwd: string; environmentKeys: string[]; principal: string } };
type Installed = { manifest: Manifest; revision: string; enabled: boolean; linkedAt: string; workspaceRoot?: string | null; sourceDirectory?: string };
type Receipt = { id: string; plugin_id: string; action_id: string; status: string; started_at: string; exit_code: number | null; stdout: string | null; stderr: string | null; error: string | null };
type Inventory = { installed: Installed[]; damaged: string[]; receipts: Receipt[] };

const buttonStyle: CSSProperties = { minHeight: 28, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 7, backgroundColor: 'var(--t-input-bg)', color: 'var(--t-text)', paddingTop: 5, paddingBottom: 5, paddingLeft: 10, paddingRight: 10, fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300, cursor: 'pointer' };
const boxStyle: CSSProperties = { borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 12, paddingTop: 18, paddingBottom: 18, paddingLeft: 18, paddingRight: 18 };
const metaStyle: CSSProperties = { color: 'var(--t-text-muted)', fontSize: 12, fontWeight: 300, lineHeight: 1.5 };

async function request<T>(body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/customize/actions', body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }
    : { cache: 'no-store', signal });
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? 'The action plugin request failed.');
  return payload;
}

export default function PluginsTab({ repoPath, repos = [], onSelectRepo }: {
  repoPath?: string | null;
  repos?: ActionRepository[];
  onSelectRepo?: (path: string | null) => void;
}) {
  const [inventory, setInventory] = useState<Inventory>({ installed: [], damaged: [], receipts: [] });
  const [directory, setDirectory] = useState('');
  const [sourceReview, setReview] = useState<Review | null>(null);
  const review = sourceReview && (sourceReview.manifest.workspace === 'none' || sourceReview.execution.cwd === repoPath) ? sourceReview : null;
  const [busy, setBusy] = useState<string | null>('loading');
  const [waitStage, setWaitStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const runControllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const result = await request<Inventory>();
    setInventory({ installed: result.installed ?? [], damaged: result.damaged ?? [], receipts: result.receipts ?? [] });
  }, []);
  useEffect(() => {
    let alive = true;
    void refresh().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : 'Could not load action plugins.'); })
      .finally(() => { if (alive) setBusy(null); });
    return () => { alive = false; runControllerRef.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    setWaitStage(0);
    if (!busy) return;
    const checking = window.setTimeout(() => setWaitStage(1), 3_000);
    const waiting = window.setTimeout(() => setWaitStage(2), 8_000);
    return () => { window.clearTimeout(checking); window.clearTimeout(waiting); };
  }, [busy]);

  const operate = useCallback(async (label: string, body: Record<string, unknown>, after?: (result: unknown) => void, signal?: AbortSignal) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const result = await request<unknown>(body, signal);
      after?.(result);
      await refresh();
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') setNotice('Run cancelled. Refresh receipts to check the final state.');
      else setError(cause instanceof Error ? cause.message : 'The action failed.');
    } finally { runControllerRef.current = null; setBusy(null); }
  }, [refresh]);

  const reviewSource = () => {
    setReview(null);
    void operate('reviewing', { action: 'review', directory: directory.trim(), ...(repoPath ? { repo: repoPath } : {}) }, (result) => setReview((result as { review: Review }).review));
  };
  const linkSource = () => {
    if (!review) return;
    void operate('linking', { action: 'link', directory: directory.trim(), expectedRevision: review.revision, ...(review.manifest.workspace === 'registered-project' ? { repo: repoPath } : {}) }, () => {
      setReview(null); setDirectory(''); setNotice('Action plugin linked. Run an action when you are ready.');
    });
  };
  const runAction = (plugin: Installed, action: PluginAction) => {
    const controller = new AbortController();
    runControllerRef.current = controller;
    void operate(`running:${plugin.manifest.id}:${action.id}`, { action: 'invoke', id: plugin.manifest.id, actionId: action.id, revision: plugin.revision, ...(plugin.manifest.workspace === 'registered-project' ? { repo: repoPath } : {}) }, (result) => {
      setNotice(`${action.id}: ${(result as { receipt: { status: string } }).receipt.status}.`);
    }, controller.signal);
  };
  const changePlugin = (plugin: Installed, action: 'enable' | 'disable' | 'remove') => {
    void operate(`${action}:${plugin.manifest.id}`, { action, id: plugin.manifest.id, revision: plugin.revision }, () => {
      setConfirmRemove(null);
      setNotice(`${plugin.manifest.name} ${action === 'remove' ? 'removed' : action === 'enable' ? 'enabled' : 'disabled'}.`);
    });
  };

  return <section aria-label="Plugins" style={{ display: 'flex', flexDirection: 'column', gap: 20, color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
    <div><h2 style={{ marginTop: 0, marginBottom: 6, fontSize: 18, fontWeight: 400 }}>Action plugins</h2><p style={{ ...metaStyle, marginTop: 0, marginBottom: 0 }}>Link a local folder, review its exact files, then run an action. Actions run with your local user account.</p></div>
    <div style={boxStyle}>
      {onSelectRepo ? <div style={{ marginBottom: 16 }}><ActionRepositoryPicker repos={repos} repoPath={repoPath} onSelect={onSelectRepo} disabled={busy !== null} /></div> : null}
      <label htmlFor="action-plugin-folder" style={{ display: 'block', fontSize: 12, fontWeight: 300, marginBottom: 8 }}>Local plugin folder</label>
      {!onSelectRepo ? <div style={{ ...metaStyle, marginBottom: 8 }}>{repoPath ? `Selected project: ${repoPath}` : 'Select a project first for actions that need repository access.'}</div> : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input id="action-plugin-folder" value={directory} onChange={(event) => { setDirectory(event.target.value); setReview(null); }} placeholder="Absolute path to a local folder" disabled={busy !== null} style={{ flex: 1, minWidth: 0, minHeight: 30, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 7, backgroundColor: 'var(--t-input-bg)', color: 'var(--t-text)', paddingTop: 6, paddingBottom: 6, paddingLeft: 10, paddingRight: 10, fontFamily: 'var(--font-sans-system)', fontSize: 12 }} />
        <button type="button" onClick={reviewSource} disabled={busy !== null || !directory.trim()} style={buttonStyle}>Review files</button>
      </div>
      {review ? <div style={{ marginTop: 16, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider)', paddingTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 300 }}>{review.manifest.name} · v{review.manifest.version}</div>
        <div style={{ ...metaStyle, marginTop: 4 }}>{review.manifest.description}</div>
        <div style={{ ...metaStyle, marginTop: 8 }}>Revision <code>{review.revision}</code></div>
        <div style={{ ...metaStyle, marginTop: 8 }}>Review the executable text below before linking. These files run with your local user permissions.</div>
        {review.files.map((file) => <details key={file.path} style={{ borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider)', marginTop: 10, paddingTop: 10 }}>
          <summary style={{ ...metaStyle, cursor: 'pointer' }}>{file.path} ({file.bytes} bytes) · SHA-256 {file.sha256}</summary>
          <pre style={{ ...metaStyle, backgroundColor: 'var(--t-input-bg)', whiteSpace: 'pre', overflow: 'auto', scrollbarWidth: 'none', maxHeight: 360, paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, borderRadius: 7 }}>{file.content}</pre>
        </details>)}
        <div style={{ ...metaStyle, marginTop: 8 }}>Actions: {review.manifest.actions.map((action) => `${action.id} → ${action.entry}${action.args.length ? ` ${action.args.join(' ')}` : ''} (${action.timeoutMs} ms limit)`).join('; ')}</div>
        <div style={{ ...metaStyle, marginTop: 8 }}>Platforms: {review.manifest.supportedPlatforms.join(', ')}. Workspace: {review.manifest.workspace === 'none' ? 'private plugin folder' : 'selected registered project'}.</div>
        <div style={{ ...metaStyle, marginTop: 8 }}>Working directory: <code>{review.execution.cwd}</code></div>
        <div style={{ ...metaStyle, marginTop: 8 }}>Process: {review.execution.principal}; environment keys: {review.execution.environmentKeys.join(', ') || 'none'}. This does not restrict file access.</div>
        <button type="button" onClick={linkSource} disabled={busy !== null} style={{ ...buttonStyle, marginTop: 14 }}>Link reviewed revision</button>
      </div> : null}
    </div>
    {busy ? <div role="status" style={metaStyle}>{busy === 'loading' ? 'Loading action plugins…' : waitStage === 0 ? `${busy.split(':')[0]}…` : waitStage === 1 ? 'Checking the local action and its files…' : 'Waiting for the action result…'}</div> : null}
    {busy?.startsWith('running:') ? <button type="button" onClick={() => runControllerRef.current?.abort()} style={{ ...buttonStyle, alignSelf: 'flex-start' }}>Cancel run</button> : null}
    {error ? <div role="alert" style={{ ...metaStyle, color: 'var(--t-error, #ef4444)' }}>{error}</div> : null}
    {notice ? <div role="status" style={metaStyle}>{notice}</div> : null}
    {inventory.damaged.length ? <div role="alert" style={{ ...metaStyle, color: 'var(--t-error, #ef4444)' }}>Damaged installations: {inventory.damaged.join(', ')}. Their actions are unavailable.</div> : null}
    {inventory.installed.length === 0 && !busy ? <div style={boxStyle}><div style={{ fontSize: 13, fontWeight: 300 }}>No action plugins linked</div><div style={{ ...metaStyle, marginTop: 5 }}>Instruction bundles remain in Skills.</div></div> : null}
    {inventory.installed.map((plugin) => <div key={plugin.manifest.id} style={boxStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}><div style={{ fontSize: 13.5, fontWeight: 300 }}>{plugin.manifest.name} <span style={metaStyle}>v{plugin.manifest.version}</span></div><span style={metaStyle}>{plugin.enabled ? 'Enabled' : 'Disabled'}</span></div>
      <div style={{ ...metaStyle, marginTop: 5 }}>{plugin.manifest.description}</div>
      <div style={{ ...metaStyle, marginTop: 8 }}>Revision <code>{plugin.revision.slice(0, 12)}</code></div>
      {plugin.sourceDirectory ? <div style={{ ...metaStyle, marginTop: 8 }}>Linked from <code>{plugin.sourceDirectory}</code></div> : null}
      {plugin.manifest.workspace === 'registered-project' ? <div style={{ ...metaStyle, marginTop: 8 }}>{plugin.workspaceRoot ? `Bound project: ${plugin.workspaceRoot}` : 'Project binding unavailable.'}</div> : null}
      {plugin.manifest.actions.map((action) => <div key={action.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider)', marginTop: 12, paddingTop: 12 }}><div><div style={{ fontSize: 12, fontWeight: 300 }}>{action.id}</div><div style={{ ...metaStyle, marginTop: 3 }}>{action.description}</div></div><button type="button" onClick={() => runAction(plugin, action)} disabled={!plugin.enabled || busy !== null || (plugin.manifest.workspace === 'registered-project' && repoPath !== plugin.workspaceRoot)} style={buttonStyle}>Run</button></div>)}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button type="button" onClick={() => changePlugin(plugin, plugin.enabled ? 'disable' : 'enable')} disabled={busy !== null} style={buttonStyle}>{plugin.enabled ? 'Disable' : 'Enable'}</button>
        {confirmRemove === plugin.manifest.id ? <><button type="button" onClick={() => changePlugin(plugin, 'remove')} disabled={busy !== null} style={{ ...buttonStyle, color: 'var(--t-error, #ef4444)' }}>Confirm removal</button><button type="button" onClick={() => setConfirmRemove(null)} style={buttonStyle}>Cancel</button></> : <button type="button" onClick={() => setConfirmRemove(plugin.manifest.id)} disabled={busy !== null} style={{ ...buttonStyle, color: 'var(--t-error, #ef4444)' }}>Remove</button>}
      </div>
    </div>)}
    {inventory.receipts.length ? <div style={boxStyle}><div style={{ fontSize: 13, fontWeight: 300, marginBottom: 10 }}>Recent runs</div>{inventory.receipts.slice(0, 8).map((receipt) => <details key={receipt.id} style={{ borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider)', paddingTop: 9, paddingBottom: 9 }}><summary style={{ ...metaStyle, cursor: 'pointer' }}>{receipt.plugin_id} / {receipt.action_id} · {receipt.status} · {new Date(receipt.started_at).toLocaleString()}</summary><div style={{ ...metaStyle, marginTop: 8 }}>Exit {receipt.exit_code ?? 'none'}{receipt.error ? ` · ${receipt.error}` : ''}</div>{receipt.stdout ? <pre style={{ ...metaStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto', scrollbarWidth: 'none' }}>{receipt.stdout}</pre> : null}{receipt.stderr ? <pre style={{ ...metaStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto', scrollbarWidth: 'none' }}>{receipt.stderr}</pre> : null}</details>)}</div> : null}
    <button type="button" onClick={() => { setBusy('loading'); void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not refresh.')).finally(() => setBusy(null)); }} disabled={busy !== null} style={{ ...buttonStyle, alignSelf: 'flex-start' }}>Refresh plugins</button>
  </section>;
}
