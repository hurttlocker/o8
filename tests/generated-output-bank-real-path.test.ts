import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
