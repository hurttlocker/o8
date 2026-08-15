import { writeFile } from 'node:fs/promises';

import { formatMissingCliError } from '@/lib/runtimes/shared/cli-unavailable';
import { prependOwnedRun } from './run-ledger';
import type {
  OwnedRunMode,
  OwnedRunRecord,
  OwnedSessionRecord,
} from './types';

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
  const message = formatMissingCliError({
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
  prependOwnedRun(session, run);

  return run;
}
