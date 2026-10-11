import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const scope = vi.hoisted(() => ({ root: '' }));
vi.mock('@/lib/llm/repo-scope', () => ({ getDefaultLlmRepoRoot: () => scope.root, resolveRegisteredRepoScope: async (path: string) => ({ repoRoot: path === scope.root ? scope.root : null, repo: null }) }));
import { GET as diff } from '@/app/api/panel/file-diff/route';
import { GET as asset } from '@/app/api/panel/file-asset/route';
import { GET as content } from '@/app/api/v2/files/route';
const request = (endpoint: string, path: string, extra: Record<string, string> = {}, headers?: HeadersInit) => new NextRequest(`http://localhost/api/${endpoint}?${new URLSearchParams({ path, workspace: scope.root, ...extra })}`, { headers });
beforeEach(async () => {
  scope.root = await mkdtemp(join(tmpdir(), 'o8-review-preview-'));
  execFileSync('git', ['init', '-q', scope.root]); await writeFile(join(scope.root, 'source.txt'), 'before\n');
  execFileSync('git', ['add', '.'], { cwd: scope.root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture'], { cwd: scope.root });
});
afterEach(async () => { await rm(scope.root, { recursive: true, force: true }); });
describe('bounded review and file previews', () => {
  it('distinguishes media, nested directories, full text, and oversized diffs', async () => {
    await writeFile(join(scope.root, 'clip.mp4'), Buffer.from([0, 1, 2])); await mkdir(join(scope.root, 'nested'));
    expect(await (await diff(request('panel/file-diff', 'clip.mp4'))).json()).toMatchObject({ kind: 'video', size: 3, diff: '', diffStatus: 'binary' });
    expect(await (await diff(request('panel/file-diff', 'nested'))).json()).toMatchObject({ kind: 'directory', diffStatus: 'directory' });
    await writeFile(join(scope.root, 'source.txt'), 'after\n');
    expect(await (await diff(request('panel/file-diff', 'source.txt'))).json()).toMatchObject({ kind: 'text', diff: expect.stringContaining('+after'), diffStatus: 'ready' });
    await writeFile(join(scope.root, 'source.txt'), 'line\n'.repeat(140_000));
    expect(await (await diff(request('panel/file-diff', 'source.txt'))).json()).toMatchObject({ diff: '', diffStatus: 'too_large', size: 700_000 });
  });
  it('serves byte ranges from the confined media descriptor and rejects invalid ranges', async () => {
    await writeFile(join(scope.root, 'clip.mp4'), Buffer.from('0123456789'));
    const response = await asset(request('panel/file-asset', 'clip.mp4', {}, { Range: 'bytes=2-5' }));
    expect(response.status).toBe(206); expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10'); expect(await response.text()).toBe('2345');
    const suffix = await asset(request('panel/file-asset', 'clip.mp4', {}, { Range: 'bytes=-3' })); expect(await suffix.text()).toBe('789');
    const invalid = await asset(request('panel/file-asset', 'clip.mp4', {}, { Range: 'bytes=99-' })); expect(invalid.status).toBe(416); expect(invalid.headers.get('Content-Range')).toBe('bytes */10');
    await symlink('/etc/passwd', join(scope.root, 'escape.mp4')); expect((await asset(request('panel/file-asset', 'escape.mp4'))).status).toBe(404);
    expect((await diff(request('panel/file-diff', '../escape'))).status).toBe(403);
  });
  it('bounds a read-only file preview without truncating the normal file API or changing disk contents', async () => {
    const original = 'readable line\n'.repeat(100_000); await writeFile(join(scope.root, 'large.txt'), original);
    const preview = await (await content(request('v2/files', 'large.txt', { preview: '1' }))).json();
    expect(preview.truncated).toBe(true); expect(Buffer.byteLength(preview.content)).toBe(1024 * 1024); expect(preview.size).toBe(Buffer.byteLength(original));
    const full = await (await content(request('v2/files', 'large.txt'))).json(); expect(full.content).toBe(original); expect(full.contentHash).toBeTruthy();
    expect(await readFile(join(scope.root, 'large.txt'), 'utf8')).toBe(original);
  });
  it('keeps comparison revisions and leading-dash filenames from becoming Git options', async () => {
    const output = join(scope.root, 'unexpected-output');
    expect((await diff(request('panel/file-diff', 'source.txt', { base: `--output=${output}` }))).status).toBe(400);
    await expect(readFile(`${output}...HEAD`)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(scope.root, '--notes.txt'), 'safe filename\n');
    expect(await (await diff(request('panel/file-diff', '--notes.txt'))).json()).toMatchObject({ diff: expect.stringContaining('+safe filename'), diffStatus: 'ready' });
  });
});
