import 'server-only';

import { promises as fs } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { getDefaultLlmRepoRoot, resolveRegisteredRepoScope } from '@/lib/llm/repo-scope';

export const APPROVAL_REPO_ROOT_METADATA_KEY = 'RepoRoot';

type ApplyApprovalFileEditError = {
  ok: false;
  code:
    | 'missing_edit_metadata'
    | 'invalid_repo_root'
    | 'invalid_file_path'
    | 'file_not_found'
    | 'path_not_file'
    | 'read_failed'
    | 'text_not_found'
    | 'ambiguous_match'
    | 'write_failed';
  error: string;
  filePath?: string;
  status: number;
};

type ApplyApprovalFileEditResult =
  | {
    ok: true;
    filePath: string;
    message: string;
  }
  | ApplyApprovalFileEditError;

function normalizePathForDisplay(projectRoot: string, resolvedPath: string) {
  return relative(projectRoot, resolvedPath).split('\\').join('/');
}

async function resolveApprovalRepoRoot(approval: ApprovalRecord): Promise<
ApplyApprovalFileEditError | { ok: true; repoRoot: string }
> {
  const defaultRepoRoot = resolve(getDefaultLlmRepoRoot());
  const metadataRepoRoot = approval.metadata?.[APPROVAL_REPO_ROOT_METADATA_KEY]?.trim();

  if (!metadataRepoRoot) {
    return { ok: true, repoRoot: defaultRepoRoot };
  }

  const normalizedMetadataRoot = resolve(metadataRepoRoot);
  if (normalizedMetadataRoot === defaultRepoRoot) {
    return { ok: true, repoRoot: defaultRepoRoot };
  }

  const scoped = await resolveRegisteredRepoScope(normalizedMetadataRoot);
  if (!scoped.repoRoot) {
    return {
      ok: false,
      code: 'invalid_repo_root',
      error: 'Approval repo root is not registered.',
      status: 400,
    };
  }

  return {
    ok: true,
    repoRoot: resolve(scoped.repoRoot),
  };
}

function resolveApprovalFilePayload(approval: ApprovalRecord) {
  const filePath = typeof approval.diff?.path === 'string' && approval.diff.path.trim()
    ? approval.diff.path.trim()
    : typeof approval.args?.file_path === 'string' && approval.args.file_path.trim()
      ? approval.args.file_path.trim()
      : null;
  const oldText = typeof approval.diff?.before === 'string'
    ? approval.diff.before
    : typeof approval.args?.old_text === 'string'
      ? approval.args.old_text
      : null;
  const newText = typeof approval.diff?.after === 'string'
    ? approval.diff.after
    : typeof approval.args?.new_text === 'string'
      ? approval.args.new_text
      : null;

  if (!filePath || oldText === null || newText === null || oldText.length === 0) {
    return null;
  }

  return { filePath, oldText, newText };
}

function resolveTargetPath(projectRoot: string, filePath: string): ApplyApprovalFileEditError | {
  ok: true;
  relativePath: string;
  resolvedPath: string;
} {
  const normalizedPath = filePath.trim();
  if (!normalizedPath || normalizedPath.includes('\0') || normalizedPath.startsWith('file://')) {
    return {
      ok: false,
      code: 'invalid_file_path',
      error: 'Approval file path is invalid.',
      status: 400,
    };
  }
  if (normalizedPath.split(/[\\/]/).includes('..')) {
    return {
      ok: false,
      code: 'invalid_file_path',
      error: 'Approval file path cannot escape the project directory.',
      status: 403,
    };
  }

  const resolvedPath = resolve(projectRoot, normalizedPath);
  const relativePath = relative(projectRoot, resolvedPath);
  if (!relativePath || relativePath === '' || relativePath.startsWith('..') || relativePath === '..') {
    return {
      ok: false,
      code: 'invalid_file_path',
      error: 'Approval file path must stay within the project directory.',
      status: 403,
    };
  }

  return {
    ok: true,
    relativePath: normalizePathForDisplay(projectRoot, resolvedPath),
    resolvedPath,
  };
}

export async function applyApprovedFileEdit(approval: ApprovalRecord): Promise<ApplyApprovalFileEditResult> {
  const payload = resolveApprovalFilePayload(approval);
  if (!payload) {
    return {
      ok: false,
      code: 'missing_edit_metadata',
      error: 'Approval is missing file edit metadata.',
      status: 400,
    };
  }

  const repoRoot = await resolveApprovalRepoRoot(approval);
  if (!repoRoot.ok) {
    return repoRoot;
  }

  const target = resolveTargetPath(repoRoot.repoRoot, payload.filePath);
  if (!target.ok) {
    return target;
  }

  let stat;
  try {
    stat = await fs.stat(target.resolvedPath);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      return {
        ok: false,
        code: 'file_not_found',
        error: `File not found: ${target.relativePath}.`,
        filePath: target.relativePath,
        status: 404,
      };
    }
    return {
      ok: false,
      code: 'read_failed',
      error: error instanceof Error ? error.message : 'Unable to inspect file for approval.',
      filePath: target.relativePath,
      status: 500,
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      code: 'path_not_file',
      error: `${target.relativePath} is not a file.`,
      filePath: target.relativePath,
      status: 400,
    };
  }

  let original: string;
  try {
    original = await fs.readFile(target.resolvedPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      code: 'read_failed',
      error: error instanceof Error ? error.message : 'Unable to read file for approval.',
      filePath: target.relativePath,
      status: 500,
    };
  }

  const firstIndex = original.indexOf(payload.oldText);
  if (firstIndex === -1) {
    return {
      ok: false,
      code: 'text_not_found',
      error: `The approved edit could not be applied because the original text was not found in ${target.relativePath}. The file may have changed since approval was created.`,
      filePath: target.relativePath,
      status: 409,
    };
  }

  const lastIndex = original.lastIndexOf(payload.oldText);
  if (firstIndex !== lastIndex) {
    return {
      ok: false,
      code: 'ambiguous_match',
      error: `The approved edit could not be applied because the original text matches multiple locations in ${target.relativePath}.`,
      filePath: target.relativePath,
      status: 409,
    };
  }

  const updated = `${original.slice(0, firstIndex)}${payload.newText}${original.slice(firstIndex + payload.oldText.length)}`;

  try {
    await fs.writeFile(target.resolvedPath, updated, 'utf8');
  } catch (error) {
    return {
      ok: false,
      code: 'write_failed',
      error: error instanceof Error ? error.message : 'Unable to write approved file edit.',
      filePath: target.relativePath,
      status: 500,
    };
  }

  return {
    ok: true,
    filePath: target.relativePath,
    message: `Applied approved edit to ${target.relativePath}.`,
  };
}
