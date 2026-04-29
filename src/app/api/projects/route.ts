import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  addRepoToProject,
  createProject,
  listProjects,
} from '@/lib/projects/store';
import type { ProjectRole, SuggestionOrigin } from '@/lib/projects/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const projects = listProjects();
    return NextResponse.json({ projects }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list projects.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface CreateProjectBody {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  repoIds?: unknown;
  // Optional parallel array of roles aligned to repoIds, or a map { repoId: role }.
  roles?: unknown;
  suggestionOrigin?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) out.push(entry);
  }
  return out;
}

function resolveRoleForRepo(
  repoId: string,
  index: number,
  roles: unknown,
): ProjectRole | null {
  if (!roles) return null;
  if (Array.isArray(roles)) {
    const candidate = roles[index];
    return typeof candidate === 'string' && candidate ? (candidate as ProjectRole) : null;
  }
  if (typeof roles === 'object') {
    const entry = (roles as Record<string, unknown>)[repoId];
    return typeof entry === 'string' && entry ? (entry as ProjectRole) : null;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  let body: CreateProjectBody;
  try {
    body = (await req.json()) as CreateProjectBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const name = asString(body.name)?.trim();
  if (!name) {
    return NextResponse.json({ error: 'Project name is required.' }, { status: 400 });
  }

  try {
    const project = createProject({
      name,
      slug: asString(body.slug),
      description: asString(body.description) ?? null,
    });

    const repoIds = asStringArray(body.repoIds) ?? [];
    const suggestionOrigin =
      (asString(body.suggestionOrigin) as SuggestionOrigin | undefined) ?? 'manual';

    const repos = repoIds.map((repoId, index) => {
      const role = resolveRoleForRepo(repoId, index, body.roles);
      return addRepoToProject(project.id, repoId, role, suggestionOrigin);
    });

    return NextResponse.json(
      { project: { ...project, repos } },
      { status: 201, headers: NO_STORE },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create project.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
