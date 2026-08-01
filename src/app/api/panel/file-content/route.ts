export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';
import { expandHome } from '@/lib/fs/safe-path';
import { isWorkspaceFileError, readWorkspaceFile } from '@/lib/fs/workspace-file';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    const workspaceParam = searchParams.get('workspace');

    if (!filePath) {
      return NextResponse.json({ content: null, error: 'path param required' }, { status: 400 });
    }

    // Resolve the root. A caller-supplied workspace MUST be a registered repo —
    // never an arbitrary root. This closes the CRIT-3 arbitrary-read where
    // workspace=/ turned the guard into a no-op (SECURITY_AUDIT_2026-07-02 §CRIT-3).
    let root: string | null;
    if (workspaceParam) {
      const { repoRoot } = await resolveRegisteredRepoScope(expandHome(workspaceParam));
      root = repoRoot;
      if (!root) {
        return NextResponse.json({ content: null, error: 'Workspace is not a registered repository' }, { status: 400 });
      }
    } else {
      root = getDefaultLlmRepoRoot();
    }

    const opened = await readWorkspaceFile(root, filePath);
    const content = opened.bytes.toString('utf-8');
    // Truncate large files
    if (content.length > 100000) {
      return NextResponse.json({
        content: content.slice(0, 100000) + '\n\n... (truncated at 100KB)',
        path: filePath,
        truncated: true,
      });
    }
    return NextResponse.json({ content, path: filePath });
  } catch (error) {
    console.error('[panel/file-content] Could not read file', error);
    if (isWorkspaceFileError(error)) {
      return NextResponse.json({ content: null, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ content: null, error: 'Could not read file', code: 'workspace_file_operation_failed' }, { status: 500 });
  }
}
