import {
  type McpTool,
  type McpToolResult,
  apiFetch,
  jsonResult,
  optionalString,
  requiredString,
  textResult,
} from './shared';

type ProjectLedger = {
  activeProjectId?: string;
  projects?: Array<{
    id: string;
    name: string;
    color?: string;
    repoPaths?: string[];
  }>;
};

export const REPO_MGMT_TOOLS: McpTool[] = [
  {
    name: 'o8_register_repo',
    description:
      'USE THIS WHEN the user says "register this folder", "add /path/to/repo to o8", or "track this project in o8". Registers an existing local git repo in o8 so agents can dispatch into it without using the sidebar + button. Example: o8_register_repo({path: "/Users/me/Projects/app"})',
    inputSchema: {
      // No top-level anyOf — OpenAI strict function-calling rejects oneOf /
      // anyOf / allOf siblings to `type: 'object'`. The handler's
      // requiredPath() validates that either `path` or `repoPath` is present
      // and throws a clear message if not.
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or ~/ path, to an existing local git repo. Either path or repoPath is required.',
        },
        repoPath: {
          type: 'string',
          description: 'Alias for path. Either path or repoPath is required.',
        },
      },
    },
  },
  {
    name: 'o8_init_repo',
    description:
      'USE THIS WHEN the user says "start a new project at /tmp/foo" or "initialize a repo here". Creates the folder if needed, runs git init on main, makes an initial commit, and registers the repo in o8. Example: o8_init_repo({path: "~/Projects/hello-world", name: "hello-world"})',
    inputSchema: {
      // No top-level anyOf — see comment on o8_register_repo. Handler's
      // requiredPath() enforces either-or.
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or ~/ path, where the repo should exist. Either path or repoPath is required.',
        },
        repoPath: {
          type: 'string',
          description: 'Alias for path. Either path or repoPath is required.',
        },
        name: {
          type: 'string',
          description: 'Optional project name used for the initial README.',
        },
      },
    },
  },
  {
    name: 'o8_create_project',
    description:
      'USE THIS WHEN the user says "create project named X" or "start a new project". Creates an o8 sidebar project and optionally assigns registered repo paths to it. Example: o8_create_project({name: "Website", repoPaths: ["/Users/me/Projects/site"]})',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Project name to show in o8.',
        },
        color: {
          type: 'string',
          description: 'Optional project color from o8 project palette.',
        },
        repoPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional absolute paths, or ~/ paths, for repos to assign to the project.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'o8_scaffold',
    description:
      'USE THIS WHEN the user says "scaffold a nextjs app here", "set up a fresh Python project", or "help me start a hello-world web project". Creates/initializes the repo, writes a starter project, commits it, and registers it in o8. Example: o8_scaffold({repoPath: "~/Projects/hello-world", kind: "static-html"})',
    inputSchema: {
      // No top-level anyOf — see comment on o8_register_repo. Handler's
      // requiredPath() enforces either-or for path/repoPath. `kind` is the
      // only schema-required field.
      type: 'object',
      properties: {
        repoPath: {
          type: 'string',
          description: 'Absolute path, or ~/ path, where the repo should be scaffolded. Either repoPath or path is required.',
        },
        path: {
          type: 'string',
          description: 'Alias for repoPath. Either repoPath or path is required.',
        },
        kind: {
          type: 'string',
          enum: ['nextjs', 'next', 'node', 'static-html', 'static-web', 'python'],
          description: 'Scaffold kind. static-web is accepted as an alias for static-html.',
        },
        name: {
          type: 'string',
          description: 'Optional project/package name.',
        },
      },
      required: ['kind'],
    },
  },
];

function requiredPath(args: Record<string, unknown>, primary: 'path' | 'repoPath') {
  const first = args[primary];
  const fallback = args[primary === 'path' ? 'repoPath' : 'path'];
  const value = typeof first === 'string' && first.trim()
    ? first
    : typeof fallback === 'string' && fallback.trim()
      ? fallback
      : '';
  if (!value) {
    throw new Error(`${primary} is required`);
  }
  return value.trim();
}

function repoFromResponse(data: Record<string, unknown>) {
  const repo = data.repo && typeof data.repo === 'object'
    ? data.repo as Record<string, unknown>
    : {};
  return {
    repoId: typeof repo.id === 'string' ? repo.id : null,
    repoPath: typeof repo.localPath === 'string'
      ? repo.localPath
      : typeof data.repoPath === 'string'
        ? data.repoPath
        : null,
  };
}

function normalizeRepoPath(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : '';
}

async function projectIdForRepo(repoPath: string | null): Promise<string | null> {
  if (!repoPath) return null;
  try {
    const ledger = await apiFetch('/api/panel/projects') as ProjectLedger;
    const target = normalizeRepoPath(repoPath);
    const project = (ledger.projects ?? []).find((entry) => (
      (entry.repoPaths ?? []).some((candidate) => normalizeRepoPath(candidate) === target)
    ));
    return project?.id ?? ledger.activeProjectId ?? null;
  } catch {
    return null;
  }
}

function activeProjectFromLedger(ledger: ProjectLedger) {
  const activeId = ledger.activeProjectId;
  return (ledger.projects ?? []).find((project) => project.id === activeId)
    ?? (ledger.projects ?? [])[0]
    ?? null;
}

export async function handleRegisterRepo(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const path = requiredPath(args, 'path');
    const data = await apiFetch('/api/panel/repos', {
      method: 'POST',
      body: JSON.stringify({ action: 'add', localPath: path }),
    }) as Record<string, unknown>;
    if (typeof data.error === 'string') {
      return textResult(data.error, true);
    }
    const repo = repoFromResponse(data);
    const projectId = await projectIdForRepo(repo.repoPath);
    return jsonResult({
      registered: true,
      repoId: repo.repoId,
      repoPath: repo.repoPath,
      projectId,
    });
  } catch (error) {
    return textResult(`Failed to register repo: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

export async function handleInitRepo(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const path = requiredPath(args, 'path');
    const data = await apiFetch('/api/panel/repos/init', {
      method: 'POST',
      body: JSON.stringify({ path, name: optionalString(args, 'name') || undefined }),
    }) as Record<string, unknown>;
    if (typeof data.error === 'string') {
      return textResult(data.error, true);
    }
    const repo = repoFromResponse(data);
    return jsonResult({
      initialized: true,
      repoId: repo.repoId,
      repoPath: repo.repoPath,
      projectId: typeof data.projectId === 'string' ? data.projectId : null,
      initialCommit: data.initialCommit === true,
    });
  } catch (error) {
    return textResult(`Failed to initialize repo: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

export async function handleCreateProject(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const name = requiredString(args, 'name');
    let ledger = await apiFetch('/api/panel/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }) as ProjectLedger & { error?: string };
    if (typeof ledger.error === 'string') {
      return textResult(ledger.error, true);
    }

    const project = activeProjectFromLedger(ledger);
    if (!project) {
      return textResult('Project was created but the project ledger did not return it.', true);
    }

    const patch: { color?: string; repoPaths?: string[] } = {};
    const color = optionalString(args, 'color');
    if (color) patch.color = color;
    if (Array.isArray(args.repoPaths)) {
      patch.repoPaths = args.repoPaths
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean);
    }
    if (patch.color || patch.repoPaths) {
      ledger = await apiFetch(`/api/panel/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }) as ProjectLedger & { error?: string };
      if (typeof ledger.error === 'string') {
        return textResult(ledger.error, true);
      }
    }

    const updated = (ledger.projects ?? []).find((entry) => entry.id === project.id) ?? project;
    return jsonResult({
      projectId: updated.id,
      name: updated.name,
      color: updated.color ?? null,
      repoPaths: updated.repoPaths ?? [],
    });
  } catch (error) {
    return textResult(`Failed to create project: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

export async function handleScaffold(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoPath = requiredPath(args, 'repoPath');
    const kind = requiredString(args, 'kind');
    const data = await apiFetch('/api/panel/repos/scaffold', {
      method: 'POST',
      body: JSON.stringify({
        repoPath,
        kind,
        name: optionalString(args, 'name') || undefined,
      }),
    }) as Record<string, unknown>;
    if (typeof data.error === 'string') {
      return textResult(data.error, true);
    }
    const repo = repoFromResponse(data);
    return jsonResult({
      scaffolded: data.scaffolded === true,
      repoId: repo.repoId,
      repoPath: repo.repoPath,
      projectId: typeof data.projectId === 'string' ? data.projectId : null,
      kind: data.kind,
      filesWritten: Array.isArray(data.filesWritten) ? data.filesWritten : [],
      committed: data.committed === true,
    });
  } catch (error) {
    return textResult(`Failed to scaffold repo: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}
