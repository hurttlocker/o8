'use client';

/** One project first: reopen a registered folder or optionally clone from GitHub. */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { requestPrompt } from '@/components/shared/ConfirmToastHost';
import { isTauri } from '@/lib/tauri/bridge';
import type { OnboardingRequest } from './request';
import { isOnboardingProject, type OnboardingProject } from './onboarding-progress';

const FONT = 'var(--font-sans-system)';
const SOURCE_WEB_FOLDER_ERROR = 'The native o8 shell is required to choose a folder. From this source checkout, run `npm run build:cli` then `node cli/dist/o8.mjs repo add /absolute/path`.';

// ── GitHub device flow state (owned by the parent, passed down read-only) ──
export interface DeviceFlowState {
  stage: 'idle' | 'waiting' | 'polling' | 'success' | 'error';
  userCode?: string;
  verificationUrl?: string;
  error?: string;
}

interface GithubRepo {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
}

// Unified list item — a GitHub repo or a locally-added folder both render + select
// through the same row and the same selection Set.
interface RepoItem {
  key: string;
  title: string;
  subtitle?: string | null;
  language?: string | null;
  isPrivate?: boolean;
  isLocal: boolean;
  name: string;
  cloneUrl?: string;
  project?: OnboardingProject;
}

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      border: '2px solid var(--t-text-faint)',
      borderTopColor: 'var(--t-accent)',
      animation: 'spin 1s linear infinite',
      flexShrink: 0,
    }} />
  );
}

const secondaryButtonStyle = (disabled = false): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  minHeight: 44,
  paddingTop: 11,
  paddingBottom: 11,
  paddingLeft: 18,
  paddingRight: 18,
  borderRadius: 12,
  border: '1px solid var(--t-glass-border-strong)',
  background: 'var(--t-glass-muted-strong)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  color: 'var(--t-text-strong)',
  fontSize: 14,
  fontWeight: 600,
  fontFamily: FONT,
  cursor: disabled ? 'default' : 'pointer',
  letterSpacing: '-0.01em',
  opacity: disabled ? 0.5 : 1,
});

// Reuse the canonical dashboard folder-pick chain (useGlobalRepoState.handleOpenFolder).
async function pickFolderPath(request: OnboardingRequest): Promise<string | null> {
  let folderPath: string | null = null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, title: 'Select project folder' });
    if (typeof result === 'string') folderPath = result;
  } catch {
    try {
      const response = await request('/api/panel/browse-folder', { method: 'POST' });
      const data = await response.json() as { path?: string | null };
      if (data.path) folderPath = data.path;
    } catch {
      folderPath = await requestPrompt({ title: 'Open folder', message: 'Enter the folder path to add as a repository.', placeholder: '/path/to/folder' });
    }
  }
  const trimmed = folderPath?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export interface OnboardingReposStepProps {
  request?: OnboardingRequest;
  pickFolder?: () => Promise<string | null>;
  deviceFlowEnabled: boolean;
  githubFlow: DeviceFlowState;
  /** Starts the GitHub device flow; onSuccess runs when auth completes. */
  onConnectGithub: (onSuccess: () => void) => void;
  onSkip: () => void;
  onBusyChange?: (busy: boolean) => void;
  selectedProject?: OnboardingProject | null;
  onContinue: (project: OnboardingProject) => void;
  renderContinueButton: (opts: { label: string; onClick: () => void; disabled: boolean }) => ReactNode;
}

export function OnboardingReposStep({
  request = fetch,
  pickFolder,
  deviceFlowEnabled,
  githubFlow,
  onConnectGithub,
  onSkip,
  onContinue,
  selectedProject,
  onBusyChange,
  renderContinueButton,
}: OnboardingReposStepProps) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([]);
  const [localRepos, setLocalRepos] = useState<RepoItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(selectedProject ? [selectedProject.localPath] : []));
  const [localRevision, setLocalRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [showGithub, setShowGithub] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reposError, setReposError] = useState<string | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  // True only while a just-picked folder is being registered (POST in flight).
  // Distinct from `addingFolder` (which also covers the native picker) so we can
  // pin a pending row and keep the empty state from re-flashing mid-add (#1344).
  const [registering, setRegistering] = useState(false);
  // Per-repo clone progress (#1339): key → status while Continue clones + registers.
  const [rowStatus, setRowStatus] = useState<Record<string, 'cloning' | 'done' | 'error'>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { onBusyChange?.(saving || addingFolder); return () => onBusyChange?.(false); }, [addingFolder, onBusyChange, saving]);
  // 'fetch' errors offer a Retry (re-fetch) button; 'action' errors (folder add,
  // clone) explain their own retry path and don't re-fetch the list.
  const [errorKind, setErrorKind] = useState<'fetch' | 'action'>('fetch');

  const loadStatusAndRepos = useCallback(async () => {
    setLoading(true);
    setReposError(null);
    try {
      const statusRes = await request('/api/panel/github-status');
      const status = statusRes.ok ? await statusRes.json() : { authenticated: false };
      const isAuthed = Boolean(status?.authenticated);
      setAuthenticated(isAuthed);
      if (!isAuthed) { setLoading(false); return; }
      const res = await request('/api/panel/repos?source=github&limit=50');
      if (!res.ok) throw new Error(`Repo fetch failed (${res.status})`);
      const data = await res.json();
      setGithubRepos(Array.isArray(data.repos) ? data.repos : Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[onboarding] repo fetch failed', err);
      setErrorKind('fetch');
      setReposError('Couldn’t load your GitHub repositories. Check your connection and retry.');
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    let active = true;
    setReposError(null);
    void request('/api/panel/repos').then(async (response) => {
      if (!response.ok) throw new Error('Could not load saved projects.');
      const data = await response.json();
      if (active) {
        const loaded: RepoItem[] = (Array.isArray(data.repos) ? data.repos : []).filter(isOnboardingProject).map((project: OnboardingProject) => ({
          key: project.localPath, title: project.name, subtitle: project.localPath, isLocal: true, name: project.name, project,
        }));
        // A folder can finish registering while this older inventory read is in flight.
        setLocalRepos((current) => [...current.filter((item) => !loaded.some((row) => row.key === item.key)), ...loaded]);
      }
    }).catch(() => { if (active) { setErrorKind('fetch'); setReposError('Could not load saved projects. You can still choose a folder.'); } });
    return () => { active = false; };
  }, [localRevision, request]);
  useEffect(() => { if (showGithub) void loadStatusAndRepos(); else setLoading(false); }, [loadStatusAndRepos, showGithub]);

  const toggle = useCallback((key: string) => {
    setSelected(new Set([key]));
  }, []);

  const handleAddFolder = useCallback(async () => {
    if (addingFolder) return;
    if (!pickFolder && !isTauri()) {
      setErrorKind('action');
      setReposError(SOURCE_WEB_FOLDER_ERROR);
      return;
    }
    setAddingFolder(true);
    try {
      const folderPath = await (pickFolder ? pickFolder() : pickFolderPath(request));
      if (!folderPath) return;
      // Folder chosen — registration is now in flight. Pin the pending state so
      // the empty state doesn't re-flash before the repo row renders (#1344).
      setRegistering(true);
      const response = await request('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', localPath: folderPath }),
      });
      const data = await response.json() as { error?: string; repo?: { id: string; name: string; localPath: string } };
      if (!response.ok || !data.repo) throw new Error(data.error ?? 'Unable to add repository.');
      const item: RepoItem = {
        key: data.repo.localPath,
        title: data.repo.name,
        subtitle: data.repo.localPath,
        isLocal: true,
        name: data.repo.name,
        project: data.repo,
      };
      setLocalRepos(prev => prev.some(r => r.key === item.key) ? prev : [item, ...prev]);
      setSelected(new Set([item.key]));
      console.info('[onboarding] added local repo', item.key);
    } catch (err) {
      console.error('[onboarding] add folder failed', err);
      setErrorKind('action');
      setReposError(err instanceof Error ? err.message : 'Unable to add that folder.');
    } finally {
      setAddingFolder(false);
      setRegistering(false);
    }
  }, [addingFolder, pickFolder, request]);

  const allItems = useMemo<RepoItem[]>(() => {
    const gh: RepoItem[] = githubRepos.map(r => ({
      key: r.full_name,
      title: r.full_name,
      subtitle: r.description,
      language: r.language,
      isPrivate: r.private,
      isLocal: false,
      name: r.name,
      cloneUrl: r.clone_url,
    }));
    return [...localRepos, ...(showGithub ? gh : [])];
  }, [githubRepos, localRepos, showGithub]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allItems;
    const q = search.toLowerCase();
    return allItems.filter(r => r.title.toLowerCase().includes(q) || (r.subtitle ?? '').toLowerCase().includes(q));
  }, [allItems, search]);

  const handleContinue = useCallback(async () => {
    if (saving) return;
    const repo = allItems.find((item) => selected.has(item.key));
    if (!repo) return;
    if (repo.project) { onContinue(repo.project); return; }
    if (!repo.cloneUrl) return;
    setSaving(true);
    setReposError(null);
    setRowStatus({ [repo.key]: 'cloning' });
    try {
      const response = await request('/api/panel/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clone', cloneUrl: repo.cloneUrl, name: repo.name }) });
      const data = await response.json();
      if (!response.ok || !isOnboardingProject(data.repo)) throw new Error(data.error ?? 'Unable to clone this project.');
      setRowStatus({ [repo.key]: 'done' });
      onContinue(data.repo);
    } catch (cause) {
      setRowStatus({ [repo.key]: 'error' });
      setErrorKind('action');
      setReposError(cause instanceof Error ? cause.message : 'Unable to clone this project. Try again.');
    } finally { setSaving(false); }
  }, [allItems, selected, saving, onContinue, request]);

  // The search box is only meaningful once there's at least one repo to filter.
  const showSearch = allItems.length > 0;
  const connecting = githubFlow.stage === 'waiting' || githubFlow.stage === 'polling';

  return (
    <div style={{ maxWidth: 640, width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5, textAlign: 'center' }}>
        Start with one project. Choose a folder or reopen a project already in o8. You can add more later.
      </div>

      {/* Local folders are the primary path. */}
          <button
            type="button"
            disabled={addingFolder || saving}
            onClick={handleAddFolder}
            style={{ ...secondaryButtonStyle(addingFolder), alignSelf: 'flex-start' }}
          >
            {addingFolder ? <Spinner /> : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
            )}
            Choose a folder on this Mac
          </button>
      <button type="button" aria-expanded={showGithub} disabled={saving} onClick={() => setShowGithub((value) => !value)} style={{ ...secondaryButtonStyle(), alignSelf: 'flex-start', fontSize: 12 }}>
        {showGithub ? 'Hide GitHub projects' : 'Clone from GitHub (optional)'}
      </button>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 24, justifyContent: 'center', color: 'var(--t-text-secondary)', fontSize: 13 }}>
          <Spinner /> Checking GitHub &amp; loading your repositories&hellip;
        </div>
      ) : (
        <>
          {/* GitHub-not-connected notice */}
          {showGithub && authenticated === false && (
            <div style={{ paddingTop: 16, paddingBottom: 16, paddingLeft: 18, paddingRight: 18, borderRadius: 12, border: '1px solid var(--t-glass-border-strong)', background: 'var(--t-glass-muted)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
                <div style={{ fontSize: 12.5, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                  {deviceFlowEnabled
                    ? <>Give o8 access to your repositories to clone + manage them &mdash; this is separate from your o8 account sign-in. Connect your repos here, or add a folder from this Mac below.</>
                    : <>GitHub isn&rsquo;t connected on this machine yet &mdash; your o8 account sign-in doesn&rsquo;t grant repo access. Add a folder from this Mac below; you can connect GitHub later from the dashboard.</>}
                </div>
              </div>
              {deviceFlowEnabled && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    type="button"
                    disabled={connecting}
                    onClick={() => onConnectGithub(() => { void loadStatusAndRepos(); })}
                    style={{ ...secondaryButtonStyle(connecting), alignSelf: 'flex-start' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.48v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.59.69.48A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" /></svg>
                    {connecting ? `Connecting…${githubFlow.userCode ? ` (${githubFlow.userCode})` : ''}` : 'Connect your GitHub repos'}
                  </button>
                  {githubFlow.stage === 'error' && githubFlow.error && (
                    <div style={{ fontSize: 11, color: 'var(--t-brand-red, #ef9a9a)' }}>{githubFlow.error}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Fetch or folder-add error — surfaced in every state, never swallowed */}
          {reposError && (
            <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, borderRadius: 12, border: '1px solid var(--t-brand-red, #ef9a9a)', background: 'var(--t-glass-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 12.5, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>{reposError}</div>
              {errorKind === 'fetch' && (
                <button type="button" onClick={() => { setLocalRevision((value) => value + 1); if (showGithub) void loadStatusAndRepos(); }} style={{ ...secondaryButtonStyle(), minHeight: 36, paddingTop: 8, paddingBottom: 8, fontSize: 12.5, flexShrink: 0 }}>Retry</button>
              )}
            </div>
          )}

          {/* Search — only when there's something to filter */}
          {showSearch && (
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search repos..."
              style={{
                width: '100%',
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: 10,
                border: '1px solid var(--t-glass-border-strong)',
                background: 'var(--t-glass-muted)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                color: 'var(--t-text)',
                fontSize: 13,
                fontFamily: FONT,
                outline: 'none',
                boxSizing: 'border-box',
              } as React.CSSProperties}
            />
          )}

          {/* Registering a just-picked folder — pinned pending row so the empty
              state never re-flashes during the add round-trip (#1344). */}
          {registering && allItems.length === 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 20, justifyContent: 'center', color: 'var(--t-text-secondary)', fontSize: 13 }}>
              <Spinner /> Adding repository&hellip;
            </div>
          )}

          {/* Zero repos anywhere — copy branched on GitHub connection so an
              unconnected machine never references a GitHub account it was never
              linked to (#1344). */}
          {allItems.length === 0 && !reposError && !registering && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13, lineHeight: 1.5 }}>
              {authenticated !== true
                ? <>Add a local repository folder to get started.</>
                : <>No repos found on your GitHub account. Use &ldquo;Choose a folder on this Mac&rdquo; below, or add repos later from the dashboard.</>}
            </div>
          )}

          {/* Repo list */}
          {allItems.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 300, overflowY: 'auto', paddingRight: 4 }}>
              {filtered.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>No repos match your search.</div>
              ) : (
                filtered.map((repo) => {
                  const isSel = selected.has(repo.key);
                  return (
                    <button
                      key={repo.key}
                      type="button"
                      onClick={() => toggle(repo.key)}
                      disabled={saving}
                      aria-pressed={isSel}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        paddingTop: 10,
                        paddingBottom: 10,
                        paddingLeft: 14,
                        paddingRight: 14,
                        borderRadius: 10,
                        border: isSel ? '1px solid var(--t-accent-border)' : '1px solid transparent',
                        background: isSel ? 'var(--t-accent-soft)' : 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: FONT,
                        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                      }}
                    >
                      <div style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        border: isSel ? '2px solid var(--t-accent)' : '2px solid var(--t-text-faint)',
                        background: isSel ? 'var(--t-accent)' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                      }}>
                        {isSel && (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.title}</div>
                        {repo.subtitle && (
                          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{repo.subtitle}</div>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {rowStatus[repo.key] === 'cloning' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 600, color: 'var(--t-text-muted)' }}>
                            <Spinner size={11} /> Cloning
                          </span>
                        )}
                        {rowStatus[repo.key] === 'done' && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="Added"><path d="M20 6L9 17l-5-5" /></svg>
                        )}
                        {rowStatus[repo.key] === 'error' && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-brand-red, #ef9a9a)' }}>Failed</span>
                        )}
                        {repo.isLocal && <span style={{ fontSize: 9, fontWeight: 700, paddingTop: 2, paddingBottom: 2, paddingLeft: 6, paddingRight: 6, borderRadius: 999, background: 'var(--t-accent-soft)', color: 'var(--t-accent)' }}>Local</span>}
                        {repo.language && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-faint)' }}>{repo.language}</span>}
                        {repo.isPrivate && <span style={{ fontSize: 9, fontWeight: 700, paddingTop: 2, paddingBottom: 2, paddingLeft: 6, paddingRight: 6, borderRadius: 999, background: 'var(--t-divider)', color: 'var(--t-text-muted)' }}>Private</span>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <button type="button" disabled={saving || addingFolder} onClick={onSkip} style={{ border: 'none', background: 'transparent', color: 'var(--t-text-faint)', fontSize: 12, cursor: 'pointer', fontFamily: FONT, padding: 0 }}>Choose later</button>
        {renderContinueButton({
          label: saving
            ? 'Cloning project…'
            : selected.size > 0 ? 'Use this project' : 'Choose a project',
          onClick: () => { void handleContinue(); },
          disabled: selected.size === 0 || saving || !allItems.some((item) => selected.has(item.key)),
        })}
      </div>
    </div>
  );
}
