import { writeFile } from 'node:fs/promises';

import { getRuntimeInstallInfo } from '@/lib/setup/runtime-install';
import type {
  OwnedRunMode,
  OwnedRunRecord,
  OwnedSessionRecord,
} from './types';

function buildMissingCliRunError({
  runtimeId,
  binaryName,
  humanLabel,
  envOverride,
  triedPaths,
}: {
  runtimeId: string;
  binaryName: string;
  humanLabel: string;
  envOverride: string;
  triedPaths: string[];
}) {
  const install = getRuntimeInstallInfo(runtimeId);
  const installHint = install?.command
    ? `Install it with: ${install.command}`
    : install?.link
      ? `Install it from: ${install.link}`
      : `Install ${binaryName} and make it available on PATH.`;
  const envHint = `If it is already installed, set ${envOverride} to the absolute ${binaryName} path and retry.`;
  const tried = triedPaths.length > 0
    ? ` Resolver checked ${triedPaths.slice(0, 8).join(', ')}${triedPaths.length > 8 ? ', ...' : ''}.`
    : '';

  return `${humanLabel} dispatch failed before launch: '${binaryName}' CLI was not found. ${installHint}. ${envHint}${tried}`;
}

export async function stageMissingCliRun({
  runtimeId,
  binaryName,
  humanLabel,
  envOverride,
  triedPaths,
  session,
  runId,
  mode,
  prompt,
  stdoutPath,
  stderrPath,
  finishedAt,
}: {
  runtimeId: string;
  binaryName: string;
  humanLabel: string;
  envOverride: string;
  triedPaths: string[];
  session: OwnedSessionRecord;
  runId: string;
  mode: OwnedRunMode;
  prompt: string;
  stdoutPath: string;
  stderrPath: string;
  finishedAt: string;
}): Promise<OwnedRunRecord> {
  const message = buildMissingCliRunError({
    runtimeId,
    binaryName,
    humanLabel,
    envOverride,
    triedPaths,
  });
  await writeFile(stderrPath, `${message}\n`, 'utf8');
  const run: OwnedRunRecord = {
    id: runId,
    mode,
    prompt,
    startedAt: finishedAt,
    finishedAt,
    pid: 0,
    stdoutPath,
    stderrPath,
    outcome: 'failed',
  };

  session.latestPrompt = prompt;
  session.latestSummary = message;
  session.reviewDisposition = 'watching';
  session.reviewDispositionUpdatedAt = finishedAt;
  session.activeRun = undefined;
  session.recentRuns = [run, ...session.recentRuns].slice(0, 16);

  return run;
}
