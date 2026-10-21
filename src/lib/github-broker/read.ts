import 'server-only';

import { githubInstallationFetch } from './auth';

const MAX_BYTES = 2_000_000;
const DEADLINE_MS = 40_000;
const EVIDENCE_HEADERS = ['link', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'x-ratelimit-used', 'x-ratelimit-reset', 'x-ratelimit-resource', 'x-github-request-id'];

const THREAD_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$after:String) {'
  + ' repository(owner:$owner,name:$name) { nameWithOwner isPrivate pullRequest(number:$number) {'
  + ' number headRefOid baseRefOid updatedAt reviewThreads(first:100,after:$after) {'
  + ' pageInfo { hasNextPage endCursor } nodes { id isResolved } } } } }';

const OWNERSHIP_QUERY = 'query($owner:String!,$name:String!) {'
  + ' repository(owner:$owner,name:$name) { nameWithOwner isPrivate pullRequests(states:OPEN,first:100) {'
  + ' pageInfo { hasNextPage } nodes { number title body headRefName files(first:100) {'
  + ' pageInfo { hasNextPage } nodes { path } } } } } }';

export class GitHubReadError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

function badRequest(): never {
  throw new GitHubReadError('github_read_request_invalid', 400);
}

function endpoint(raw: string): string {
  if (raw.length > 2000 || !raw.startsWith('/') || raw.startsWith('//') || /[\s\u0000-\u001f]/.test(raw)) badRequest();
  const [path, query, extra] = raw.split('?');
  if (extra !== undefined || path.includes('%') || path.includes('..') && !path.startsWith('/compare/')) badRequest();
  const single = /^\/(?:issues|pulls)\/[1-9][0-9]{0,6}$/;
  const events = /^\/(?:issues\/[1-9][0-9]{0,6}\/comments|pulls\/[1-9][0-9]{0,6}\/(?:comments|reviews|files))$/;
  const commits = /^\/commits\/[a-f0-9]{40}(?:\/(?:check-runs|status|statuses))?$/;
  const compare = /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/;
  const lists = path === '/issues' || path === '/pulls';
  if (!(path === '/' || path === '' || single.test(path) || events.test(path) || commits.test(path) || compare.test(path) || lists)) badRequest();
  if (query === undefined) return path === '/' ? '' : path;
  if (!query || query.endsWith('&') || single.test(path) || path === '/') badRequest();
  const params = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) badRequest();
    seen.add(key);
    if (key === 'per_page' && /^(?:[1-9][0-9]?|100)$/.test(value)) continue;
    if (key === 'page' && /^(?:[1-9]|10)$/.test(value)) continue;
    if (lists && key === 'state' && /^(?:open|closed|all)$/.test(value)) continue;
    if (path === '/issues' && key === 'labels' && /^[\w/-]{1,64}$/.test(value)) continue;
    if (path === '/pulls' && key === 'head' && /^[\w.-]+:[\w./-]{1,200}$/.test(value) && !value.includes('..')) continue;
    if (path.endsWith('/check-runs') && key === 'filter' && /^(?:latest|all)$/.test(value)) continue;
    badRequest();
  }
  params.sort();
  return `${path}?${params}`;
}

function input(params: URLSearchParams) {
  const names = [...params.keys()];
  if (new Set(names).size !== names.length) badRequest();
  const repo = params.get('repo') ?? '';
  if (!/^[a-zA-Z0-9][\w.-]{0,100}\/[a-zA-Z0-9][\w.-]{0,100}$/.test(repo)) badRequest();
  const timeout = params.get('timeoutMs');
  if (timeout !== null && (!/^[1-9][0-9]{0,4}$/.test(timeout) || Number(timeout) > DEADLINE_MS)) badRequest();
  const timeoutMs = timeout === null ? DEADLINE_MS : Number(timeout);
  if (params.get('kind') === 'ownership') {
    if (names.some((name) => !['repo', 'kind', 'timeoutMs'].includes(name))) badRequest();
    const [owner, name] = repo.split('/');
    return { repo, timeoutMs, path: '/graphql', init: { method: 'POST', body: JSON.stringify({ query: OWNERSHIP_QUERY,
      variables: { owner, name } }) } };
  }
  if (params.get('kind') === 'review-threads') {
    if (names.some((name) => !['repo', 'kind', 'number', 'after', 'timeoutMs'].includes(name))) badRequest();
    const number = params.get('number') ?? '';
    const after = params.get('after');
    if (!/^[1-9][0-9]{0,6}$/.test(number) || after !== null && !/^[a-zA-Z0-9+/=_-]{1,512}$/.test(after)) badRequest();
    const [owner, name] = repo.split('/');
    return { repo, timeoutMs, path: '/graphql', init: { method: 'POST', body: JSON.stringify({ query: THREAD_QUERY,
      variables: { owner, name, number: Number(number), after } }) } };
  }
  if (names.some((name) => !['repo', 'path', 'timeoutMs'].includes(name)) || !params.has('path')) badRequest();
  return { repo, timeoutMs, path: '/repos/' + repo + endpoint(params.get('path')!), init: { method: 'GET' } };
}

async function jsonWithinBound(response: Response, signal: AbortSignal): Promise<unknown> {
  const stream = response.body?.getReader();
  if (!stream) throw new GitHubReadError('github_read_body_missing', 502);
  const stop = () => { void stream.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (signal.aborted) throw new GitHubReadError('github_read_deadline_exceeded', 504);
      const part = await stream.read();
      if (signal.aborted) throw new GitHubReadError('github_read_deadline_exceeded', 504);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new GitHubReadError('github_read_body_exceeds_bound', 502);
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    stop();
    if (error instanceof GitHubReadError) throw error;
    throw new GitHubReadError('github_read_body_invalid', 502);
  } finally {
    signal.removeEventListener('abort', stop);
    stream.releaseLock();
  }
}

function evidence(response: Response) {
  return Object.fromEntries(EVIDENCE_HEADERS.flatMap((name) => {
    const value = response.headers.get(name);
    return value === null ? [] : [[name, value]];
  }));
}

export async function readGitHubRequest(params: URLSearchParams) {
  const selected = input(params);
  const controller = new AbortController();
  let rejectDeadline: (reason: GitHubReadError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new GitHubReadError('github_read_deadline_exceeded', 504));
  }, selected.timeoutMs);
  const options = { redirect: 'error' as const, signal: controller.signal };
  const work = async () => {
    const repository = await githubInstallationFetch(selected.repo, '/repos/' + selected.repo, { ...options, method: 'GET' });
    if (!repository.response.ok) {
      void repository.response.body?.cancel().catch(() => {});
      return { ok: false, error: { code: 'github_repository_read_failed' },
        authSource: 'github-app', installationId: repository.installation.id, repo: selected.repo,
        response: { status: repository.response.status, headers: evidence(repository.response) } };
    }
    const metadata = await jsonWithinBound(repository.response, controller.signal) as { full_name?: unknown; private?: unknown } | null;
    if (!metadata || metadata.private !== false || typeof metadata.full_name !== 'string'
        || metadata.full_name.toLowerCase() !== selected.repo.toLowerCase()) {
      throw new GitHubReadError('github_public_repository_required', 422);
    }
    const result = selected.path === '/repos/' + selected.repo ? repository
      : await githubInstallationFetch(selected.repo, selected.path, { ...options, ...selected.init });
    if (result.installation.id !== repository.installation.id) throw new GitHubReadError('github_installation_changed', 409);
    let data: unknown = metadata;
    if (result !== repository) {
      try {
        data = await jsonWithinBound(result.response, controller.signal);
      } catch (error) {
        if (result.response.ok || error instanceof GitHubReadError && error.status === 504) throw error;
        data = null;
      }
    }
    return { ok: true, authSource: 'github-app', installationId: result.installation.id, repo: selected.repo,
      request: { path: selected.path, method: selected.init.method },
      response: { status: result.response.status, headers: evidence(result.response), data }, verifiedAt: Date.now() };
  };
  try {
    return { schema: 'o8/github-read/v1', ...await Promise.race([work(), deadline]) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
