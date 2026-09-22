'use client';

import type { RepoFocusRepo } from './types';
import { normalizeRepoPath, REPO_FOCUS_FONT } from './utils';

export function RepoScopeNotice({ selectedRepo, workingRepoPath, repos, onWorkInRepo }: {
  selectedRepo: RepoFocusRepo;
  workingRepoPath: string | null;
  repos: RepoFocusRepo[];
  onWorkInRepo?: (repo: RepoFocusRepo) => void;
}) {
  const normalizedWorkingPath = normalizeRepoPath(workingRepoPath);
  const workingRepo = repos.find((repo) => normalizeRepoPath(repo.localPath) === normalizedWorkingPath);
  const workingLabel = workingRepo?.name ?? normalizedWorkingPath.split('/').filter(Boolean).at(-1) ?? 'none selected';
  const alreadyWorkingHere = normalizedWorkingPath === normalizeRepoPath(selectedRepo.localPath);

  return (
    <div style={{ marginTop: 0, marginRight: 10, marginBottom: 6, marginLeft: 10, paddingTop: 7, paddingRight: 9, paddingBottom: 7, paddingLeft: 9, borderRadius: 7, background: 'var(--t-input-bg)', fontFamily: REPO_FOCUS_FONT }}>
      <div style={{ fontSize: 10, lineHeight: '14px', fontWeight: 300, color: 'var(--t-text)' }}>
        Browsing {selectedRepo.name} conversations
      </div>
      <div style={{ marginTop: 2, fontSize: 9.5, lineHeight: '13px', fontWeight: 260, color: 'var(--t-text-faint)' }}>
        Working repository: {workingLabel}
      </div>
      {!alreadyWorkingHere && onWorkInRepo ? (
        <button
          type="button"
          onClick={() => onWorkInRepo(selectedRepo)}
          style={{ marginTop: 6, minHeight: 26, borderWidth: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text)', cursor: 'pointer', paddingTop: 0, paddingRight: 8, paddingBottom: 0, paddingLeft: 8, fontFamily: REPO_FOCUS_FONT, fontSize: 11, fontWeight: 300 }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          Work in this repository
        </button>
      ) : null}
    </div>
  );
}
