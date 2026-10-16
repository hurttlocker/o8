import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRetainedGeneratedOutputFixture } from './generated-output-fixture';

import { captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { captureGeneratedOutputBank, validateGeneratedOutputBank,
  verifyGeneratedOutputBank } from '@/lib/workspace/generated-output-bank';
import type { BankWriteReceipt } from '@/lib/workspace/generated-output-bank-io';

async function fixture() {
  const root = await createRetainedGeneratedOutputFixture('o8-generated-bank-');
  const sourcePath = path.join(root, '.next');
  await mkdir(path.join(sourcePath, 'cache'), { recursive: true });
  const payload = Buffer.from('generated build bytes\n'.repeat(2048));
  await writeFile(path.join(sourcePath, 'cache', 'proof.bin'), payload, { mode: 0o444 });
  await writeFile(path.join(sourcePath, 'empty'), '');
  return { root, payload, source: await captureWorktreeMaterializationIdentity(sourcePath),
    parent: await captureWorktreeMaterializationIdentity(root), bankPath: path.join(root, 'bank') };
}

describe('native generated-output bank custody', () => {
  it('records actual file ownership before bytes and verifies the entire compressed bank', async () => {
    const input = await fixture();
    const phases = new Map<number, string[]>();
    const receipts: BankWriteReceipt[] = [];
    const bank = await captureGeneratedOutputBank({ ...input, register: async () => {},
      receipt: async (index, _entry, phase, value) => {
        phases.set(index, [...(phases.get(index) ?? []), phase]);
        if (value) receipts.push(value);
        if (phase === 'prepared') {
          const parent = index === -1 ? input.bankPath : path.join(input.bankPath, 'files');
          const named = await lstat(path.join(parent, index === -1 ? 'manifest.json' : `${index}.gz`));
          expect(named.size).toBe(0);
          expect(named.dev).toBe(value!.device);
          expect(named.ino).toBe(value!.inode);
        }
      } });
    expect(bank.expandedBytes).toBe(input.payload.length);
    expect(bank.compressedBytes).toBeGreaterThan(0);
    expect(receipts.every(value => value.pid > 0 && value.processIdentity)).toBe(true);
    for (const phasesForFile of phases.values()) {
      expect(phasesForFile).toEqual(['planned', 'ready', 'prepared', 'written', 'complete']);
    }
    expect(phases.has(-1)).toBe(true);
    await verifyGeneratedOutputBank(bank);
    expect(await readFile(path.join(input.source.canonicalPath, 'cache', 'proof.bin'))).toEqual(input.payload);
    const invalid = { ...bank, expandedBytes: -1 };
    expect(() => validateGeneratedOutputBank(invalid)).toThrow('authority');
    const entries = bank.entries.map(row => ({ ...row }));
    entries.find(row => row.kind === 'file')!.compressedName = '../outside.gz';
    const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    expect(() => validateGeneratedOutputBank({ ...bank, entries, digest })).toThrow('compressed entry');
    const compressed = bank.entries.find(row => row.bytes > 0)!;
    await writeFile(path.join(bank.files.canonicalPath, compressed.compressedName!), 'changed bank');
    await expect(verifyGeneratedOutputBank(bank)).rejects.toThrow('compressed file');
  }, 30_000);

  it('refuses a rejected prepared receipt before writing and preserves the original source inode and bytes', async () => {
    const input = await fixture();
    const sourceBefore = await lstat(path.join(input.source.canonicalPath, 'cache', 'proof.bin'));
    let prepared: { index: number; value: BankWriteReceipt } | undefined;
    await expect(captureGeneratedOutputBank({ ...input, register: async () => {},
      receipt: async (index, _entry, phase, value) => {
        if (phase === 'prepared') {
          prepared = { index, value: value! };
          throw new Error('durable bank receipt was rejected');
        }
      } })).rejects.toThrow('durable bank receipt');
    expect(prepared).toBeDefined();
    const partial = await lstat(path.join(input.bankPath, 'files', `${prepared!.index}.gz`));
    expect(partial.size).toBe(0);
    expect(partial.dev).toBe(prepared!.value.device);
    expect(partial.ino).toBe(prepared!.value.inode);
    const sourceAfter = await lstat(path.join(input.source.canonicalPath, 'cache', 'proof.bin'));
    expect({ device: sourceAfter.dev, inode: sourceAfter.ino }).toEqual({ device: sourceBefore.dev, inode: sourceBefore.ino });
    expect(await readFile(path.join(input.source.canonicalPath, 'cache', 'proof.bin'))).toEqual(input.payload);
    await expect(lstat(path.join(input.bankPath, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
});

// These cases exercise only the new opt-in preservation child boundary. They
// neither enumerate host processes nor use the aggregate bank draft.
describe('preservation writer observed closure', () => {
  it('carries observed closure through actual Git capture and descriptor publication', async () => {
    const { capturePreservationGitBundle, executePreservationBankOperation } = await import('@/lib/workspace/git-bundle-preservation');
    const input = await fixture();
    const repo = path.join(input.root, 'repo');
    await mkdir(repo, { mode: 0o700 });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-q', '--template=');
    await writeFile(path.join(repo, 'proof'), 'portable writer closure');
    git('add', 'proof');
    git('-c', 'user.name=regression', '-c', 'user.email=regression@example.test', 'commit', '-qm', 'fixture');
    const ref = 'refs/o8/recovery/closure';
    git('update-ref', ref, 'HEAD');
    const repositoryIdentity = await captureWorktreeMaterializationIdentity(repo);
    const bankPath = path.join(input.root, 'git-bundles');
    await mkdir(bankPath, { mode: 0o700 });
    const bankIdentity = await captureWorktreeMaterializationIdentity(bankPath);
    const directory = path.join(bankPath, '.prepare-closure');
    await mkdir(directory, { mode: 0o700 });
    const identity = await captureWorktreeMaterializationIdentity(directory);
    const snapshot = { recoveryRef: ref } as import('@/lib/worktree/snapshot-state').WorkspaceSnapshotRecord;
    const captured = await capturePreservationGitBundle(snapshot, repo, repositoryIdentity, directory, identity);
    expect(captured).toMatchObject({ ok: true, settled: true });
    expect(captured.writers).toMatchObject([{ role: 'wrapper', observedClose: true }, { role: 'nested', observedClose: true }]);
    const bytes = await readFile(path.join(directory, 'source.bundle'));
    const file = await lstat(path.join(directory, 'source.bundle'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const published = await executePreservationBankOperation({ directory: bankPath, identity: bankIdentity, bankIdentity: input.parent }, {
      operation: 'publish', leaf: '.prepare-closure', identity, sha256, bytes: bytes.length,
      file: { device: file.dev, inode: file.ino },
    });
    expect(published).toMatchObject({ ok: true, settled: true });
    expect(published.writers).toMatchObject([{ role: 'wrapper', observedClose: true }, { role: 'nested', observedClose: true }]);
    expect(await readFile(path.join(bankPath, sha256 + '.bundle'))).toEqual(bytes);
    await expect(lstat(path.join(directory, 'source.bundle'))).rejects.toMatchObject({ code: 'ENOENT' });
    const failure = await capturePreservationGitBundle({ ...snapshot, recoveryRef: ref + '-absent' }, repo,
      repositoryIdentity, directory, identity).then(() => null, error => error);
    expect(failure?.settlement).toMatchObject({ ok: false, settled: true });
    expect(failure?.settlement.writers).toMatchObject([
      { role: 'wrapper', observedClose: true, code: 1 }, { role: 'nested', observedClose: true, code: 128 },
    ]);
    process.stdout.write('preservation actual capture/publication/failure ' + JSON.stringify({
      captured: captured.writers, published: published.writers, failed: failure.settlement.writers,
    }) + '\n');
  }, 60_000);

  it('refuses a replaced verifier directory in the actual nested Git child', async () => {
    const { preservationGitValue } = await import('@/lib/workspace/git-bundle-preservation');
    const execution = await import('@/lib/worktree/materialization-execution');
    const input = await fixture();
    const preparation = path.join(input.root, 'preparation');
    await mkdir(preparation, { mode: 0o700 });
    const identity = await captureWorktreeMaterializationIdentity(preparation);
    const original = execution.materializationAwareNodeSettlement;
    let replaced = false;
    const spy = vi.spyOn(execution, 'materializationAwareNodeSettlement').mockImplementation(options => original({
      ...options,
      onWriter: async writer => {
        if (writer.role !== 'nested') return;
        await rename(preparation, preparation + '-retained');
        await mkdir(preparation, { mode: 0o700 });
        await writeFile(path.join(preparation, 'sentinel'), 'replacement remains untouched');
        replaced = true;
      },
    }));
    try {
      await expect(preservationGitValue(preparation, identity, ['init', '--bare', '--template=', 'verify.git']))
        .rejects.toMatchObject({ settlement: { settled: true, ok: false,
          writers: [{ role: 'wrapper', code: 1, observedClose: true }, { role: 'nested', code: 78, observedClose: true }] } });
      expect(replaced).toBe(true);
      expect(await readFile(path.join(preparation, 'sentinel'), 'utf8')).toBe('replacement remains untouched');
      expect(await readdir(preparation)).toEqual(['sentinel']);
      expect(await readdir(preparation + '-retained')).toEqual([]);
      process.stdout.write('preservation verifier replacement refused before Git writes, nested exit78\n');
    } finally { spy.mockRestore(); }
  }, 20_000);

  it('records identity before a direct writer and distinguishes a settled error', async () => {
    const { materializationAwareNodeSettlement } = await import('@/lib/worktree/materialization-execution');
    const input = await fixture();
    const events: string[] = [];
    for (const fail of [false, true]) {
      const target = path.join(input.root, fail ? 'failed-write' : 'completed-write');
      const result = await materializationAwareNodeSettlement({ identity: input.parent,
        script: `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'owned bytes');
          ${fail ? "throw new Error('settled fixture failure');" : ''}`,
        onWriter: async writer => {
          events.push('identity:' + writer.role);
          await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        },
      });
      events.push('close:' + result.writers[0]?.code);
      expect(result).toMatchObject({ settled: true, ok: !fail, stopRequested: false });
      expect(result.writers).toMatchObject([{ role: 'wrapper', observedClose: true, code: fail ? 1 : 0, signal: null }]);
      expect(result.writers[0]!.processIdentity).not.toBeNull();
      expect(await readFile(target, 'utf8')).toBe('owned bytes');
    }
    expect(events).toEqual(['identity:wrapper', 'close:0', 'identity:wrapper', 'close:1']);
    process.stdout.write('preservation direct ordering ' + JSON.stringify(events) + '\n');
  }, 20_000);

  it('records nested producer closure on success and normal nonzero exit', async () => {
    const { materializationAwareNodeSettlement } = await import('@/lib/worktree/materialization-execution');
    const input = await fixture();
    for (const code of [0, 7]) {
      const result = await materializationAwareNodeSettlement({ identity: input.parent,
        script: `await runChild(process.execPath, ['-e', "process.stdout.write('nested bytes'); process.exitCode = ${code}"]);`,
      });
      expect(result).toMatchObject({ settled: true, ok: code === 0, stdout: 'nested bytes' });
      expect(result.writers).toMatchObject([
        { role: 'wrapper', observedClose: true, code: code === 0 ? 0 : 1 },
        { role: 'nested', observedClose: true, code },
      ]);
      expect(result.writers.every(writer => writer.processIdentity !== null)).toBe(true);
      process.stdout.write('preservation nested ordering ' + JSON.stringify(result.writers.map(({ role, code, observedClose }) => ({ role, code, observedClose }))) + '\n');
    }
  }, 20_000);

  it('retains regular descriptors across a nested publication writer gate', async () => {
    const { materializationAwareNodeSettlement } = await import('@/lib/worktree/materialization-execution');
    const input = await fixture();
    const source = path.join(input.root, 'source');
    const destination = path.join(input.root, 'published');
    await writeFile(source, 'descriptor owned bytes', { mode: 0o600 });
    const publication = `require('node:fs').writeFileSync(${JSON.stringify(destination)}, require('node:fs').readFileSync(3));`;
    const result = await materializationAwareNodeSettlement({ identity: input.parent,
      script: `const fs = require('node:fs'); const fd = fs.openSync(${JSON.stringify(source)}, 'r');
        try { await runChild(process.execPath, [], { fd, nodeScript: ${JSON.stringify(publication)} }); }
        finally { fs.closeSync(fd); }`,
      onWriter: async writer => {
        if (writer.role === 'nested') await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      },
    });
    expect(result).toMatchObject({ ok: true, settled: true });
    expect(result.writers).toHaveLength(2);
    expect(await readFile(destination, 'utf8')).toBe('descriptor owned bytes');
  }, 20_000);

  it('returns unknown after cancellation without inventing close for a live writer', async () => {
    const { materializationAwareNodeSettlement } = await import('@/lib/worktree/materialization-execution');
    const { probeMetadataLockProcessIdentity } = await import('@/lib/worktree/metadata-lock-process-identity');
    const input = await fixture();
    const controller = new AbortController();
    let pid = 0;
    const operation = materializationAwareNodeSettlement({ identity: input.parent,
      script: `await new Promise(() => {});`, signal: controller.signal, closeWaitMs: 40,
      onWriter: async writer => { pid = writer.pid; controller.abort(); },
    });
    const result = await operation;
    try {
      expect(result).toMatchObject({ ok: false, settled: false, stopRequested: true });
      expect(result.writers[0]).toMatchObject({ pid, observedClose: false });
      const live = await probeMetadataLockProcessIdentity(pid);
      expect(live).toEqual({ state: 'live', identity: result.writers[0]!.processIdentity });
      process.stdout.write('preservation cancellation ordering ' + JSON.stringify({ stopRequested: result.stopRequested, observedClose: result.writers[0]!.observedClose }) + '\n');
    } finally { process.kill(pid, 'SIGKILL'); }
  }, 20_000);

  it('does not promote wrapper exit into closure of its missing nested writer', async () => {
    const { materializationAwareNodeSettlement } = await import('@/lib/worktree/materialization-execution');
    const { probeMetadataLockProcessIdentity } = await import('@/lib/worktree/metadata-lock-process-identity');
    const input = await fixture();
    let wrapper = 0; let nested = 0;
    const result = await materializationAwareNodeSettlement({ identity: input.parent,
      script: `await runChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);`, closeWaitMs: 50,
      onWriter: async writer => {
        if (writer.role === 'wrapper') wrapper = writer.pid;
        else { nested = writer.pid; process.kill(wrapper, 'SIGKILL'); }
      },
    });
    expect(result).toMatchObject({ settled: false, ok: false });
    expect(result.writers[0]).toMatchObject({ observedClose: true, signal: 'SIGKILL' });
    expect(result.writers[1]).toMatchObject({ observedClose: false });
    // Fixture cleanup alone: no product path treats absence or kill as close.
    const probe = await probeMetadataLockProcessIdentity(nested);
    if (probe.state === 'live' && JSON.stringify(probe.identity) === JSON.stringify(result.writers[1]!.processIdentity)) process.kill(nested, 'SIGKILL');
    process.stdout.write('preservation missing nested close ' + JSON.stringify(result.writers.map(({ role, observedClose }) => ({ role, observedClose }))) + '\n');
  }, 20_000);
});
