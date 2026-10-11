export type ScratchSurface = 'file' | 'diff';

interface ScratchContext {
  repoPath?: string;
  filePath?: string;
  surface: ScratchSurface;
  selection?: string;
  content?: string;
}

const BINARY_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'ico',
  'jpg',
  'jpeg',
  'pdf',
  'png',
  'webp',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'zip',
]);

function extensionForPath(path: string) {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

function canLoadFileContext(path: string) {
  return !BINARY_EXTENSIONS.has(extensionForPath(path));
}

export async function readPanelContext({
  repoPath,
  selectedFile,
  surface,
  selection,
}: {
  repoPath?: string | null;
  selectedFile: string | null;
  surface: ScratchSurface;
  selection: string;
}): Promise<ScratchContext> {
  if (!repoPath) {
    return { surface, selection };
  }

  // No file selected → fall back to a workspace-wide change digest so the
  // cheap model isn't flying blind. Pulls the same snapshot ReviewPanel
  // renders (branch, ahead/behind, diffstat, changed-file list, recent
  // commits). Tools available in the scratch-chat API let the model drill
  // into individual file diffs if it needs the actual hunks.
  if (!selectedFile) {
    try {
      const params = new URLSearchParams({ workspace: repoPath });
      const response = await fetch(`/api/review/workspace?${params.toString()}`);
      const snap = await response.json().catch(() => ({})) as {
        branch?: string;
        ahead?: number;
        behind?: number;
        dirty?: boolean;
        diffStat?: string;
        changedFiles?: Array<{ path?: string; status?: string; additions?: number; deletions?: number }>;
        recentCommits?: string[];
        error?: string;
      };
      if (snap.error) {
        return { repoPath, surface, selection, content: `Workspace snapshot unavailable: ${snap.error}` };
      }
      const fileSummary = (snap.changedFiles ?? [])
        .slice(0, 60)
        .map((f) => {
          const stat = f.additions !== undefined && f.deletions !== undefined
            ? ` +${f.additions} -${f.deletions}`
            : '';
          return `  ${f.status ?? '?'} ${f.path ?? '?'}${stat}`;
        })
        .join('\n');
      const commits = (snap.recentCommits ?? []).slice(0, 8).join('\n');
      const lines = [
        `Branch: ${snap.branch ?? '(unknown)'}`,
        `Ahead/behind: ${snap.ahead ?? 0} / ${snap.behind ?? 0}${snap.dirty ? ' · dirty' : ''}`,
        '',
        `Diffstat:\n${snap.diffStat || '(no changes)'}`,
        '',
        fileSummary ? `Changed files (${snap.changedFiles?.length ?? 0}):\n${fileSummary}` : 'No changed files.',
        commits ? `\nRecent commits:\n${commits}` : '',
      ].filter(Boolean).join('\n');
      return { repoPath, surface, selection, content: lines };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Workspace snapshot fetch failed.';
      return { repoPath, surface, selection, content: reason };
    }
  }

  if (surface === 'diff') {
    const params = new URLSearchParams({ path: selectedFile, workspace: repoPath });
    const response = await fetch(`/api/panel/file-diff?${params.toString()}`);
    const data = await response.json().catch(() => ({})) as { diff?: string; stagedDiff?: string; error?: string };
    return {
      repoPath,
      filePath: selectedFile,
      surface,
      selection,
      content: data.error ? `Diff unavailable: ${data.error}` : data.diff ?? data.stagedDiff ?? '',
    };
  }

  if (!canLoadFileContext(selectedFile)) {
    return {
      repoPath,
      filePath: selectedFile,
      surface,
      selection,
      content: `${extensionForPath(selectedFile).toUpperCase() || 'Binary'} file selected. No text source was sent.`,
    };
  }

  const params = new URLSearchParams({ path: selectedFile, workspace: repoPath });
  const response = await fetch(`/api/v2/files?${params.toString()}`);
  const data = await response.json().catch(() => ({})) as { content?: string; error?: string };
  return {
    repoPath,
    filePath: selectedFile,
    surface,
    selection,
    content: data.error ? `File unavailable: ${data.error}` : data.content ?? '',
  };
}
