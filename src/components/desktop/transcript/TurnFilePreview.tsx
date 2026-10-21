'use client';

import { useEffect, useState } from 'react';
import { FileEditDiffPeek } from '../thoughts/chat-panel/FileEditDiffPeek';
import { buildFileDiffUrl, interpretFileDiffResponse, type PeekOutcome } from '../thoughts/chat-panel/file-edit-diff';

export function TurnFilePreview({ path, repoPath }: { path: string; repoPath: string }) {
  const [state, setState] = useState<PeekOutcome | 'loading'>('loading');
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    void fetch(buildFileDiffUrl(path, repoPath), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not load the current changes. Open Review to try again.');
      return response.json();
    }).then(data => { if (!controller.signal.aborted) setState(interpretFileDiffResponse(data)); })
      .catch(() => { if (mounted) setState({ kind: 'error', message: 'Preview unavailable. Open Review to inspect this file.' }); })
      .finally(() => clearTimeout(timeout));
    return () => { mounted = false; clearTimeout(timeout); controller.abort(); };
  }, [path, repoPath]);
  return <><div style={{ fontSize: 12, overflowWrap: 'anywhere', color: 'var(--t-text)' }}>{path}</div>
    <div style={{ fontSize: 10, color: 'var(--t-text-muted)', marginTop: 4, marginBottom: 8 }}>Current working-tree changes · click the file to open Review</div>
    <FileEditDiffPeek state={state} />
  </>;
}
