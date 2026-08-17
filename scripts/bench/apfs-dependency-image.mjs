#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TRIALS = 9;
const ARMS = ['cold', 'warm', 'seed'];
const READY_LIMIT_MS = 3000;
const GROWTH_REDUCTION_MIN = 0.60;
const installCommand = 'npm ci --ignore-scripts --no-audit --no-fund';

export function evaluateDependencyImagePromotion(input) {
  const measuredWarmSpeedup = input.warmReadinessMedianMs / input.seedReadinessMedianMs;
  const measuredGrowthReduction = input.warmAllocatedGrowthMedianBytes === 0
    ? 0
    : 1 - (input.seedAllocatedGrowthMedianBytes / input.warmAllocatedGrowthMedianBytes);
  const checks = {
    fixedReadiness: input.seedReadinessMedianMs <= READY_LIMIT_MS,
    warmSpeedup: measuredWarmSpeedup >= 2,
    physicalGrowth: measuredGrowthReduction >= GROWTH_REDUCTION_MIN,
  };
  return {
    checks,
    measuredWarmSpeedup,
    measuredGrowthReduction,
    promotion: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL/HOLD',
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function allocatedBytes(entry) {
  return Number(entry.blocks) * 512;
}

function usedBytes(before, after) {
  return Math.max(0, Number(before.bavail - after.bavail) * Number(before.bsize));
}

function shuffledArms(round) {
  let seed = (0x9e3779b9 ^ round) >>> 0;
  const result = [...ARMS];
  for (let index = result.length - 1; index > 0; index -= 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const swap = (seed >>> 0) % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd, timeout: 30_000 });
}

async function createFixture(root) {
  const fixture = path.join(root, 'fixture');
  await mkdir(fixture);
  await writeFile(path.join(fixture, 'package.json'), `${JSON.stringify({
    name: 'o8-apfs-image-benchmark',
    version: '1.0.0',
    private: true,
    dependencies: { typescript: '5.9.3' },
  })}\n`);
  await execFileAsync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: fixture,
    timeout: 180_000,
    env: { ...process.env, npm_config_userconfig: '/dev/null' },
  });
  await git(fixture, ['init', '-q']);
  await git(fixture, ['config', 'user.email', 'bench@example.invalid']);
  await git(fixture, ['config', 'user.name', 'o8 benchmark']);
  await git(fixture, ['add', 'package.json', 'package-lock.json']);
  await git(fixture, ['commit', '-qm', 'fixture']);
  return fixture;
}

async function attachSparseTrial(root, label) {
  const imagePath = path.join(root, `${label}.sparseimage`);
  const mountPath = path.join(root, `${label}-mount`);
  await mkdir(mountPath);
  await execFileAsync('/usr/bin/hdiutil', [
    'create', '-size', '512m', '-type', 'SPARSE', '-fs', 'APFS',
    '-volname', `o8tw10-${label}`, '-quiet', imagePath,
  ], { timeout: 120_000 });
  const attached = await execFileAsync('/usr/bin/hdiutil', [
    'attach', '-nobrowse', '-owners', 'on', '-mountpoint', mountPath, imagePath,
  ], { timeout: 120_000 });
  const device = attached.stdout.match(/^\/dev\/disk\d+/m)?.[0];
  if (!device) throw new Error(`Trial ${label} did not return a detachable image device.`);
  return { imagePath, mountPath, device };
}

async function runMain() {
  if (process.platform !== 'darwin') throw new Error('TW-10 benchmark requires macOS APFS.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'o8-apfs-image-bench-'));
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'server-only') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  const dependencyInstallImport = await import('../../src/lib/workspace/dependency-install.ts');
  const dependencyImageImport = await import('../../src/lib/workspace/apfs-dependency-image.ts');
  const dependencyInstall = dependencyInstallImport.default ?? dependencyInstallImport;
  const dependencyImage = dependencyImageImport.default ?? dependencyImageImport;
  const fixture = await createFixture(root);
  const npmVersion = (await execFileAsync('npm', ['--version'])).stdout.trim();
  const warmCache = path.join(root, 'warm-native-cache');
  const registryRoot = path.join(root, 'dependency-images');
  const receipt = await dependencyInstall.runDependencyInstall(fixture, installCommand, {
    cacheRoot: warmCache,
    resolveVersion: async () => npmVersion,
  });
  const sourceReceipt = await dependencyImage.captureDependencyImageSourceReceipt(
    fixture,
    installCommand,
    receipt,
    { registryRoot, resolveVersion: async () => npmVersion },
  );
  const image = await dependencyImage.publishDependencyImage(sourceReceipt, {
    registryRoot,
    resolveVersion: async () => npmVersion,
  });
  const baseImageBytes = allocatedBytes(await stat(image.imagePath, { bigint: true }));
  const results = [];
  const shadowBytes = [];
  const order = [];

  for (let round = 0; round < TRIALS; round += 1) {
      for (const arm of shuffledArms(round)) {
        order.push(`${round + 1}:${arm}`);
        const label = `r${round + 1}-${arm}`;
        const trial = await attachSparseTrial(root, label);
        let lease = null;
        try {
          const workspace = path.join(trial.mountPath, 'workspace');
          await git(root, ['clone', '-q', fixture, workspace]);
          const beforeFs = await statfs(trial.mountPath, { bigint: true });
          const beforeImage = allocatedBytes(await stat(trial.imagePath, { bigint: true }));
          const started = performance.now();
          if (arm === 'seed') {
            lease = await dependencyImage.mountDependencyImage(workspace, installCommand, receipt, {
              registryRoot,
              resolveVersion: async () => npmVersion,
            });
          } else {
            await dependencyInstall.runDependencyInstall(workspace, installCommand, {
              cacheRoot: arm === 'warm' ? warmCache : path.join(root, `cold-cache-${round}`),
              resolveVersion: async () => npmVersion,
            });
          }
          await access(path.join(workspace, 'node_modules', 'typescript', 'lib', 'typescript.js'));
          const readinessMs = performance.now() - started;
          const afterFs = await statfs(trial.mountPath, { bigint: true });
          const afterImage = allocatedBytes(await stat(trial.imagePath, { bigint: true }));
          const shadowAllocatedBytes = lease
            ? allocatedBytes(await stat(lease.shadowPath, { bigint: true }))
            : null;
          if (shadowAllocatedBytes !== null) shadowBytes.push(shadowAllocatedBytes);
          results.push({
            round: round + 1,
            arm,
            readinessMs: Number(readinessMs.toFixed(3)),
            allocatedGrowthBytes: arm === 'seed'
              ? shadowAllocatedBytes
              : Math.max(0, afterImage - beforeImage),
            statfsUsedBytes: usedBytes(beforeFs, afterFs),
            shadowAllocatedBytes,
          });
        } finally {
          if (lease) await dependencyImage.detachDependencyImageLease(lease.leaseId);
          await execFileAsync('/usr/bin/hdiutil', ['detach', trial.device, '-quiet'], { timeout: 120_000 });
        }
      }
  }

  const summary = Object.fromEntries(ARMS.map((arm) => {
    const armRows = results.filter((row) => row.arm === arm);
    return [arm, {
      readinessMedianMs: median(armRows.map((row) => row.readinessMs)),
      allocatedGrowthMedianBytes: median(armRows.map((row) => row.allocatedGrowthBytes)),
      statfsUsedMedianBytes: median(armRows.map((row) => row.statfsUsedBytes)),
    }];
  }));
  const gate = evaluateDependencyImagePromotion({
    warmReadinessMedianMs: summary.warm.readinessMedianMs,
    seedReadinessMedianMs: summary.seed.readinessMedianMs,
    warmAllocatedGrowthMedianBytes: summary.warm.allocatedGrowthMedianBytes,
    seedAllocatedGrowthMedianBytes: summary.seed.allocatedGrowthMedianBytes,
  });
  const dossier = {
    version: 1,
    trialsPerArm: TRIALS,
    randomizedOrder: order,
    fixture: { dependency: 'typescript@5.9.3', installCommand },
    summary,
    seedStorage: {
      baseImageBytes,
      shadows: shadowBytes,
      totalShadowBytes: shadowBytes.reduce((sum, value) => sum + value, 0),
      basePlusNBytes: baseImageBytes + shadowBytes.reduce((sum, value) => sum + value, 0),
    },
    thresholds: {
      seedReadinessMedianMaxMs: READY_LIMIT_MS,
      warmSpeedupMin: 2,
      physicalGrowthReductionMin: GROWTH_REDUCTION_MIN,
    },
    checks: gate.checks,
    measuredWarmSpeedup: Number(gate.measuredWarmSpeedup.toFixed(6)),
    measuredGrowthReduction: Number(gate.measuredGrowthReduction.toFixed(6)),
    promotion: gate.promotion,
    raw: results,
  };
  process.stdout.write(`${JSON.stringify(dossier, null, 2)}\n`);
  await readFile(path.join(fixture, 'package-lock.json'));
  await rm(root, { recursive: true, force: true });
  if (dossier.promotion !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain().catch((error) => {
    process.stderr.write(`[apfs-dependency-image-bench] ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
