/**
 * Smoke test for Bug 2: POST /api/projects accepts both body shapes.
 *
 * Invokes the route's POST function directly with NextRequest mocks.
 *
 * Usage:
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-projects-post.ts
 */

import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/projects/route';

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

function mkReq(body: unknown) {
  return new NextRequest('http://localhost:3001/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'host': 'localhost:3001' },
    body: JSON.stringify(body),
  });
}

type ProjectPostPayload = {
  error?: string;
  project?: {
    repos?: Array<{
      repoId?: string;
      role?: string | null;
    }>;
  };
};

async function callPost(body: unknown): Promise<{ status: number; payload: ProjectPostPayload }> {
  const res = await POST(mkReq(body));
  const payload = await res.json() as ProjectPostPayload;
  return { status: res.status, payload };
}

(async () => {
  console.log('Test: POST accepts legacy `repoIds` + `roles` shape');
  {
    const { status, payload } = await callPost({
      name: 'Legacy Project ' + Date.now(),
      repoIds: ['repo-a', 'repo-b'],
      roles: ['frontend', 'backend'],
    });
    assert(status === 201, `status 201 (got ${status}, payload=${JSON.stringify(payload)})`);
    assert(payload.project?.repos?.length === 2, `2 repos created (got ${payload.project?.repos?.length})`);
    assert(payload.project?.repos?.[0]?.role === 'frontend', `role[0]=frontend (got ${payload.project?.repos?.[0]?.role})`);
    assert(payload.project?.repos?.[1]?.role === 'backend', `role[1]=backend (got ${payload.project?.repos?.[1]?.role})`);
  }

  console.log('Test: POST accepts new `repos: [{repoId, role}]` shape');
  {
    const { status, payload } = await callPost({
      name: 'Inverse Project ' + Date.now(),
      repos: [
        { repoId: 'repo-c', role: 'frontend' },
        { repoId: 'repo-d', role: 'backend' },
      ],
    });
    assert(status === 201, `status 201 (got ${status}, payload=${JSON.stringify(payload)})`);
    assert(payload.project?.repos?.length === 2, `2 repos created (got ${payload.project?.repos?.length})`);
    assert(payload.project?.repos?.[0]?.repoId === 'repo-c', `repoId[0]=repo-c (got ${payload.project?.repos?.[0]?.repoId})`);
    assert(payload.project?.repos?.[0]?.role === 'frontend', `role[0]=frontend (got ${payload.project?.repos?.[0]?.role})`);
    assert(payload.project?.repos?.[1]?.role === 'backend', `role[1]=backend (got ${payload.project?.repos?.[1]?.role})`);
  }

  console.log('Test: POST accepts `repos` without role (role optional)');
  {
    const { status, payload } = await callPost({
      name: 'Roleless Project ' + Date.now(),
      repos: [{ repoId: 'repo-e' }],
    });
    assert(status === 201, `status 201 (got ${status})`);
    assert(payload.project?.repos?.length === 1, '1 repo');
    assert(payload.project?.repos?.[0]?.role === null, `role is null (got ${payload.project?.repos?.[0]?.role})`);
  }

  console.log('Test: POST rejects malformed `repos` (array of strings)');
  {
    const { status, payload } = await callPost({
      name: 'Bad Project ' + Date.now(),
      repos: ['repo-x', 'repo-y'],
    });
    assert(status === 400, `status 400 (got ${status})`);
    assert(typeof payload.error === 'string' && payload.error.includes('repoId'), `error mentions repoId (got ${payload.error})`);
  }

  console.log('Test: POST rejects `repos` with missing repoId');
  {
    const { status, payload } = await callPost({
      name: 'Bad Project 2 ' + Date.now(),
      repos: [{ role: 'frontend' }],
    });
    assert(status === 400, `status 400 (got ${status})`);
    assert(typeof payload.error === 'string', `error returned (got ${payload.error})`);
  }

  console.log('Test: POST rejects sending both shapes at once');
  {
    const { status, payload } = await callPost({
      name: 'Double Project ' + Date.now(),
      repoIds: ['repo-a'],
      repos: [{ repoId: 'repo-b' }],
    });
    assert(status === 400, `status 400 (got ${status})`);
    assert(typeof payload.error === 'string' && payload.error.toLowerCase().includes('both'), `error mentions both (got ${payload.error})`);
  }

  console.log('Test: POST still requires `name`');
  {
    const { status } = await callPost({ repoIds: ['repo-a'] });
    assert(status === 400, `missing name → 400 (got ${status})`);
  }

  console.log('Test: POST without repoIds or repos creates empty project (legacy behavior)');
  {
    const { status, payload } = await callPost({
      name: 'Empty Project ' + Date.now(),
    });
    assert(status === 201, `status 201 (got ${status})`);
    assert(Array.isArray(payload.project?.repos) && payload.project.repos.length === 0, 'no repos');
  }

  console.log('');
  if (failed > 0) {
    console.error(`${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('All POST smoke tests passed');
})();
