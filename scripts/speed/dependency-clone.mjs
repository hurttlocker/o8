#!/usr/bin/env node
// Existing APFS dependency clone entry point, with no package installation.
// Run with --import ./scripts/register-server-only-stub.mjs --import tsx.
import fs from 'node:fs';
import path from 'node:path';
import { root, round, distribution, writeJson } from './common.mjs';

fs.mkdirSync(path.join(root, 'tmp/speed-evidence'), { recursive: true });
const parent = fs.mkdtempSync(path.join(root, 'tmp/speed-evidence/dependency-clone-'));
process.env.O8_DATA_DIR = path.join(parent, 'data');
process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
const leafModule = await import('../../src/lib/worktree/materialization-leaf-io.ts');
const identityModule = await import('../../src/lib/worktree/materialization-identity.ts');
const leaf = leafModule.default ?? leafModule;
const identity = identityModule.default ?? identityModule;
const samples = [];
for (let sample = 1; sample <= 3; sample++) {
  const target = path.join(parent, `workspace-${sample}`);
  fs.mkdirSync(target);
  const captured = await identity.captureWorktreeMaterializationIdentity(target);
  const started = performance.now();
  const result = await leaf.clonePinnedWorkspaceDirectory(target, captured, 'node_modules', path.join(root, 'node_modules'));
  const ms = round(performance.now() - started);
  if (result.disposition !== 'created' || result.sourceChanged) throw new Error('APFS clone was not verified unchanged');
  const cloned = path.join(target, 'node_modules');
  const manifest = fs.readFileSync(path.join(cloned, 'better-sqlite3/package.json'), 'utf8');
  if (manifest !== fs.readFileSync(path.join(root, 'node_modules/better-sqlite3/package.json'), 'utf8')) throw new Error('Cloned dependency content differs');
  samples.push(ms);
  const stat = fs.lstatSync(cloned);
  if (stat.isSymbolicLink() || stat.dev !== result.device || stat.ino !== result.inode) throw new Error('Owned clone identity changed before cleanup');
  fs.rmSync(cloned, { recursive: true });
}
const receipt = { schema: 'o8/speed-dependency-clone/v1', ms: distribution(samples),
  method: 'Production clonePinnedWorkspaceDirectory on this worktree dependency tree. Verified native APFS publication receipt and copied manifest. No package manager invoked.',
  limits: 'Component calibration; excludes package installation, admission and repository-specific typecheck/build gates.' };
writeJson(path.join(root, 'tmp/speed-evidence/dependency-clone.json'), receipt);
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
