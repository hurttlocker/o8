import { type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

// Observe the actual captured child; process outcomes and filesystem operations remain native.
const observed = vi.hoisted(() => ({ children: [] as ChildProcess[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => {
    const child = Reflect.apply(actual.spawn, undefined, args) as ChildProcess;
    observed.children.push(child);
    return child;
  } };
});

import { purgeExactDirectory } from '@/lib/workspace/exact-directory-purge';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  observed.children.length = 0;
});

it('settles the captured purge child without releasing bytes when authorization rejects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'o8-purge-authorization-'));
  roots.push(root);
  const candidate = path.join(root, 'owned-output');
  await mkdir(candidate);
  const contents = 'required acceptance bytes must survive authorization rejection';
  await writeFile(path.join(candidate, 'evidence.txt'), contents);
  const identity = await lstat(candidate);
  const refusal = new Error('fresh authorization refused');
  let closed: Promise<number | null> | undefined;
  const operation = purgeExactDirectory(candidate, { device: identity.dev, inode: identity.ino }, undefined, async () => {
    const child = observed.children.at(-1)!;
    closed = new Promise(resolve => child.once('close', resolve));
    throw refusal;
  });
  await expect(operation).rejects.toBe(refusal);
  expect(closed).toBeDefined();
  const code = await closed;
  expect(await readFile(path.join(candidate, 'evidence.txt'), 'utf8')).toBe(contents);
  expect(await readdir(candidate)).toEqual(['evidence.txt']);
  const remaining = await lstat(candidate);
  expect([remaining.dev, remaining.ino]).toEqual([identity.dev, identity.ino]);
  expect(code).not.toBe(0);
}, 15_000);
