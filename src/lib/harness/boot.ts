import 'server-only';

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { getHarnessCapabilities } from './capabilities';
import { groundTask } from './ground';
import {
  canonicalRepoPath,
  listContracts,
  listFeatures,
  listGroundings,
  listSprints,
  nextFeature,
} from './store';

function git(repoPath: string, args: string[], fallback = ''): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

export function buildSessionBoot(input: {
  repoPath: string;
  task?: string | null;
  featureId?: string | null;
  packetId?: string | null;
  acceptanceCriteria?: string[];
  modelId?: string | null;
}) {
  const repoPath = canonicalRepoPath(input.repoPath);
  const features = listFeatures({ repoPath, limit: 500 });
  const contracts = listContracts(repoPath, 50);
  const sprints = listSprints(repoPath, 50);
  const latestGroundings = listGroundings(repoPath, 5);
  const grounding = input.task?.trim()
    ? groundTask({
        repoPath,
        task: input.task,
        featureId: input.featureId,
        packetId: input.packetId,
        acceptanceCriteria: input.acceptanceCriteria,
      })
    : latestGroundings[0] ?? null;
  const tracked = git(repoPath, ['ls-files']).split('\n').filter(Boolean);
  const instructionNames = new Set(['agents.md', 'claude.md', 'readme.md', 'design.md', 'styleguide.md']);

  return {
    schema: 'o8/session-boot/v1' as const,
    repoPath,
    git: {
      head: git(repoPath, ['rev-parse', 'HEAD']) || null,
      branch: git(repoPath, ['branch', '--show-current']) || null,
      dirty: git(repoPath, ['status', '--porcelain']).length > 0,
    },
    instructions: tracked
      .filter((path) => instructionNames.has(basename(path).toLowerCase()))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .slice(0, 20),
    featureSummary: {
      total: features.length,
      failing: features.filter((feature) => feature.status === 'failing').length,
      passing: features.filter((feature) => feature.status === 'passing').length,
      blocked: features.filter((feature) => feature.status === 'blocked').length,
      next: nextFeature(repoPath),
    },
    activeContract: contracts.find((contract) => contract.status === 'accepted') ?? null,
    activeSprint: sprints.find((sprint) => sprint.status !== 'completed') ?? null,
    grounding,
    capabilities: getHarnessCapabilities(input.modelId),
    bootedAt: Date.now(),
  };
}
