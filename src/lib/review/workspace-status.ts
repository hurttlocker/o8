import { stat } from 'node:fs/promises';

export class WorkspaceReviewError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export async function assertReviewWorkspace(repoRoot: string, run: (command: string, args: string[]) => Promise<string>) {
  try {
    if (!(await stat(repoRoot)).isDirectory()) throw new Error('Not a directory');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new WorkspaceReviewError('REVIEW_PATH_UNAVAILABLE', 'This folder cannot be read. Check its permissions or choose another repository.', 403);
    }
    throw new WorkspaceReviewError('REVIEW_PATH_MISSING', 'This folder is no longer available. Choose an existing repository.', 404);
  }
  let inside: string;
  try {
    inside = await run('git', ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr ?? ''))) {
      throw new WorkspaceReviewError('REVIEW_NOT_GIT', 'This folder is not a Git repository. Choose a Git repository to review changes.', 422);
    }
    throw new WorkspaceReviewError('REVIEW_GIT_UNAVAILABLE', 'Git could not inspect this folder. Check Git and repository access, then refresh.', 503);
  }
  if (inside !== 'true') {
    throw new WorkspaceReviewError('REVIEW_NOT_GIT', 'This folder is not a Git working tree. Choose a working repository to review changes.', 422);
  }
}

export async function requireReviewGit(run: (command: string, args: string[]) => Promise<string>, args: string[]) {
  try {
    return await run('git', args);
  } catch {
    throw new WorkspaceReviewError('REVIEW_GIT_UNAVAILABLE', 'Git could not read the working changes. Refresh to try again.', 503);
  }
}
