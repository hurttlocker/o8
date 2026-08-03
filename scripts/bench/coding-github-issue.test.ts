import { afterEach, describe, expect, it } from 'vitest';

import { resolveBenchmarkRepoSlug } from './coding-github-issue';

const priorGhRepo = process.env.GH_REPO;
const priorBenchRepo = process.env.O8_BENCH_REPO;

afterEach(() => {
  if (priorGhRepo === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = priorGhRepo;
  if (priorBenchRepo === undefined) delete process.env.O8_BENCH_REPO;
  else process.env.O8_BENCH_REPO = priorBenchRepo;
});

describe('benchmark repository resolution', () => {
  it('uses the pinned repository without a GraphQL lookup', () => {
    process.env.GH_REPO = 'example/project';
    delete process.env.O8_BENCH_REPO;
    expect(resolveBenchmarkRepoSlug('/path/does/not/need/to/exist')).toBe('example/project');
  });

  it('prefers the benchmark-specific pin and rejects malformed slugs', () => {
    process.env.GH_REPO = 'example/project';
    process.env.O8_BENCH_REPO = 'not a slug';
    expect(() => resolveBenchmarkRepoSlug(process.cwd())).toThrow(/invalid benchmark repository slug/);
  });
});
