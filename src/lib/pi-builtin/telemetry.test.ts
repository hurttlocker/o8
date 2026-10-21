import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

import {
  getOwnedPiBuiltinTelemetrySources,
  PI_BUILTIN_TELEMETRY_MAX_BYTES,
  readOwnedPiBuiltinTelemetryTail,
} from './telemetry';

let directory: string;
let root: string;
const suffix = 'pi-builtin-fixture';
const surfaceId = `pi-builtin-owned:${suffix}`;

function line(text: string): string {
  return `${JSON.stringify({ type: 'assistant', at: '2026-10-14T12:00:00.000Z', text })}\n`;
}

async function fixture(logs: Array<{ id: string; raw: string }> = [{ id: 'run-1', raw: line('safe') }]) {
  const sessionDir = path.join(root, suffix);
  await fs.mkdir(path.join(sessionDir, 'runs'), { recursive: true });
  const recentRuns = [];
  for (const log of logs) {
    const stdoutPath = path.join(sessionDir, 'runs', `${log.id}.jsonl`);
    await fs.writeFile(stdoutPath, log.raw);
    recentRuns.push({ id: log.id, stdoutPath });
  }
  const metadata = { surfaceId, sessionDir, threadId: 'thread-fixture', model: 'model-fixture', recentRuns };
  const metadataPath = path.join(sessionDir, 'session.json');
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  return { sessionDir, metadataPath, metadata };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'o8-pi-telemetry-'));
  root = path.join(directory, 'owned-pi-builtin');
  vi.stubEnv('O8_OWNED_PI_BUILTIN_ROOT', root);
  vi.stubEnv('O8_DATA_DIR', path.join(directory, 'unused-data-dir'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('read-only bundled Pi telemetry', () => {
  it('returns oldest-first sources and reads chronological normalized logs without changing metadata', async () => {
    const state = await fixture([{ id: 'new', raw: line('new 🐱') }, { id: 'old', raw: line('old') }]);
    const before = await fs.readFile(state.metadataPath, 'utf8');
    const statBefore = await fs.stat(state.metadataPath);
    const sources = await getOwnedPiBuiltinTelemetrySources(surfaceId);
    expect(sources).toEqual({ threadId: 'thread-fixture', model: 'model-fixture', stdoutPaths: [
      path.join(state.sessionDir, 'runs', 'old.jsonl'), path.join(state.sessionDir, 'runs', 'new.jsonl'),
    ] });
    const tail = await readOwnedPiBuiltinTelemetryTail(surfaceId);
    expect(tail.raw).toBe(line('old') + line('new 🐱'));
    expect(tail.bytesRead).toBe(Buffer.byteLength(tail.raw));
    expect(tail.modifiedAt).toBeTruthy();
    expect(await fs.readFile(state.metadataPath, 'utf8')).toBe(before);
    expect((await fs.stat(state.metadataPath)).mtimeMs).toBe(statBefore.mtimeMs);
    await expect(fs.stat(process.env.O8_DATA_DIR!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    '', 'pi-owned:fixture', 'pi-builtin:fixture', 'pi-builtin-owned:',
    ' pi-builtin-owned:fixture', 'pi-builtin-owned:..', 'pi-builtin-owned:../other',
    'pi-builtin-owned:one/two', 'pi-builtin-owned:one\\two', 'pi-builtin-owned:/absolute',
    'pi-builtin-owned:%2e%2e', 'pi-builtin-owned:.hidden', 'pi-builtin-owned:fixture\n',
    `pi-builtin-owned:${'a'.repeat(201)}`,
  ])('rejects invalid identity %j before any filesystem lookup', async (identity) => {
    vi.mocked(fs.lstat).mockClear();
    vi.mocked(fs.open).mockClear();
    vi.mocked(fs.realpath).mockClear();
    expect(await getOwnedPiBuiltinTelemetrySources(identity)).toBeNull();
    expect(await readOwnedPiBuiltinTelemetryTail(identity)).toEqual({ raw: '', bytesRead: 0 });
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.open).not.toHaveBeenCalled();
    expect(fs.realpath).not.toHaveBeenCalled();
  });

  it('does not migrate or create the default data directory for a missing session', async () => {
    vi.stubEnv('O8_OWNED_PI_BUILTIN_ROOT', '');
    expect(await getOwnedPiBuiltinTelemetrySources(surfaceId)).toBeNull();
    await expect(fs.stat(process.env.O8_DATA_DIR!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['root', 'session', 'runs', 'metadata', 'log'])('rejects a symlink at the %s component', async (component) => {
    const state = await fixture();
    const target = component === 'root' ? root : component === 'session' ? state.sessionDir
      : component === 'runs' ? path.join(state.sessionDir, 'runs')
        : component === 'metadata' ? state.metadataPath : state.metadata.recentRuns[0].stdoutPath;
    const real = `${target}.real`;
    await fs.rename(target, real);
    await fs.symlink(real, target, ['root', 'session', 'runs'].includes(component) ? 'dir' : 'file');
    expect((await getOwnedPiBuiltinTelemetrySources(surfaceId))?.stdoutPaths ?? []).toEqual([]);
    expect((await readOwnedPiBuiltinTelemetryTail(surfaceId)).raw).toBe('');
  });

  it.each(['metadata', 'log'])('rejects a nonregular %s node before reading', async (component) => {
    const state = await fixture();
    const target = component === 'metadata' ? state.metadataPath : state.metadata.recentRuns[0].stdoutPath;
    await fs.rm(target);
    await fs.mkdir(target);
    expect((await getOwnedPiBuiltinTelemetrySources(surfaceId))?.stdoutPaths ?? []).toEqual([]);
    expect((await readOwnedPiBuiltinTelemetryTail(surfaceId)).raw).toBe('');
  });

  it.each(['metadata', 'log'])('rejects hardlinked %s before opening the file', async (component) => {
    const state = await fixture([{ id: 'run-1', raw: line('private raw-provider record') }]);
    const target = component === 'metadata' ? state.metadataPath : state.metadata.recentRuns[0].stdoutPath;
    await fs.link(target, path.join(directory, `external-${component}`));
    vi.mocked(fs.open).mockClear();
    expect((await getOwnedPiBuiltinTelemetrySources(surfaceId))?.stdoutPaths ?? []).toEqual([]);
    expect((await readOwnedPiBuiltinTelemetryTail(surfaceId)).raw).toBe('');
    expect(vi.mocked(fs.open).mock.calls.some(([name]) => name === target)).toBe(false);
  });

  it.each(['malformed', 'null', 'array', 'wrong-surface', 'wrong-directory', 'relative-directory', 'no-runs', 'oversized'])(
    'fails closed on %s metadata', async (kind) => {
      const state = await fixture();
      let raw: string;
      switch (kind) {
        case 'malformed': raw = '{'; break;
        case 'null': raw = 'null'; break;
        case 'array': raw = '[]'; break;
        case 'wrong-surface': raw = JSON.stringify({ ...state.metadata, surfaceId: `${surfaceId}-other` }); break;
        case 'wrong-directory': raw = JSON.stringify({ ...state.metadata, sessionDir: `${state.sessionDir}-other` }); break;
        case 'relative-directory': raw = JSON.stringify({ ...state.metadata, sessionDir: suffix }); break;
        case 'no-runs': raw = JSON.stringify({ ...state.metadata, recentRuns: null }); break;
        default: raw = ' '.repeat(1_048_577);
      }
      await fs.writeFile(state.metadataPath, raw);
      expect(await getOwnedPiBuiltinTelemetrySources(surfaceId)).toBeNull();
      expect((await readOwnedPiBuiltinTelemetryTail(surfaceId)).raw).toBe('');
    },
  );

  it('accepts archived logs only from exact matching active or archived run paths', async () => {
    const state = await fixture();
    const archiveRoot = `${root}-archive`;
    await fs.rename(root, archiveRoot);
    const sessionDir = path.join(archiveRoot, suffix);
    const metadataPath = path.join(sessionDir, 'session.json');
    const metadata = { ...state.metadata, sessionDir };
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    const expected = path.join(sessionDir, 'runs', 'run-1.jsonl');
    expect((await getOwnedPiBuiltinTelemetrySources(surfaceId))?.stdoutPaths).toEqual([expected]);
    expect((await readOwnedPiBuiltinTelemetryTail(surfaceId)).raw).toBe(line('safe'));
    metadata.recentRuns[0].stdoutPath = expected;
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    expect((await getOwnedPiBuiltinTelemetrySources(surfaceId))?.stdoutPaths).toEqual([expected]);
    metadata.recentRuns[0].stdoutPath = path.join(root, 'different-session', 'runs', 'run-1.jsonl');
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    expect((await getOwnedPiBuiltinTelemetrySources(surfaceId))?.stdoutPaths).toEqual([]);
  });

  it('does not fall back to archive when the active identity exists but is invalid', async () => {
    const state = await fixture();
    await fs.rename(root, `${root}-archive`);
    const archivedDir = path.join(`${root}-archive`, suffix);
    await fs.writeFile(path.join(archivedDir, 'session.json'), JSON.stringify({ ...state.metadata, sessionDir: archivedDir }));
    await fs.mkdir(state.sessionDir, { recursive: true });
    await fs.writeFile(state.metadataPath, '{');
    expect(await getOwnedPiBuiltinTelemetrySources(surfaceId)).toBeNull();
  });

  it.each(['outside', 'other-session', 'wrong-filename', 'traversal', 'invalid-id', 'newline-id'])(
    'never uses a %s run reference', async (kind) => {
      const state = await fixture();
      const run = state.metadata.recentRuns[0];
      switch (kind) {
        case 'outside': run.stdoutPath = path.join(directory, 'run-1.jsonl'); break;
        case 'other-session': run.stdoutPath = path.join(root, 'other', 'runs', 'run-1.jsonl'); break;
        case 'wrong-filename': run.stdoutPath = path.join(state.sessionDir, 'runs', 'other.jsonl'); break;
        case 'traversal': run.stdoutPath = `${state.sessionDir}/runs/../runs/run-1.jsonl`; break;
        case 'invalid-id': run.id = '../run-1'; break;
        case 'newline-id': run.id = 'run-1\n'; break;
      }
      await fs.writeFile(state.metadataPath, JSON.stringify(state.metadata));
      expect((await getOwnedPiBuiltinTelemetrySources(surfaceId))?.stdoutPaths).toEqual([]);
      expect((await readOwnedPiBuiltinTelemetryTail(surfaceId)).raw).toBe('');
    },
  );

  it('caps metadata run enumeration at 32 and deduplicates run IDs', async () => {
    const logs = Array.from({ length: 33 }, (_, index) => ({ id: `run-${index}`, raw: line(`${index}`) }));
    const state = await fixture(logs);
    const sources = await getOwnedPiBuiltinTelemetrySources(surfaceId);
    expect(sources?.stdoutPaths).toHaveLength(32);
    expect(sources?.stdoutPaths[0]).toBe(path.join(state.sessionDir, 'runs', 'run-31.jsonl'));
    state.metadata.recentRuns = [state.metadata.recentRuns[0], state.metadata.recentRuns[0]];
    await fs.writeFile(state.metadataPath, JSON.stringify(state.metadata));
    expect((await getOwnedPiBuiltinTelemetrySources(surfaceId))?.stdoutPaths).toHaveLength(1);
  });

  it('shares one newest-first byte budget and discards both torn record edges', async () => {
    const raw = line('x'.repeat(PI_BUILTIN_TELEMETRY_MAX_BYTES)) + line('newest complete') + '{"type":"assistant","text":"partial';
    await fixture([{ id: 'new', raw }, { id: 'old', raw: line('old must not fit') }]);
    const tail = await readOwnedPiBuiltinTelemetryTail(surfaceId);
    expect(tail.bytesRead).toBe(PI_BUILTIN_TELEMETRY_MAX_BYTES);
    expect(tail.raw).toBe(line('newest complete'));
  });

  it('counts rejected partial lines against the budget, including across several runs', async () => {
    const newest = 'x'.repeat(150_000);
    const older = line('y'.repeat(140_000)) + line('old complete');
    await fixture([{ id: 'new', raw: newest }, { id: 'old', raw: older }]);
    const tail = await readOwnedPiBuiltinTelemetryTail(surfaceId);
    expect(tail.bytesRead).toBe(PI_BUILTIN_TELEMETRY_MAX_BYTES);
    expect(tail.raw).toBe(line('old complete'));
  });

  it('drops an unterminated final record even when it contains valid JSON', async () => {
    await fixture([{ id: 'run-1', raw: line('complete') + JSON.stringify({ type: 'assistant', text: 'still in flight' }) }]);
    expect((await readOwnedPiBuiltinTelemetryTail(surfaceId)).raw).toBe(line('complete'));
  });

  it('does not consult a raw Pi session file if normalized logs are absent', async () => {
    const state = await fixture();
    await fs.rm(state.metadata.recentRuns[0].stdoutPath);
    await fs.writeFile(path.join(state.sessionDir, 'raw-provider-session.jsonl'), line('private provider diagnostics'));
    expect((await readOwnedPiBuiltinTelemetryTail(surfaceId)).raw).toBe('');
  });
});
