import { getRuntimeInstallInfo } from '@/lib/setup/runtime-install';

export function formatMissingCliError({
  runtimeId,
  binaryName,
  humanLabel,
  envOverride,
  triedPaths = [],
}: {
  runtimeId: string;
  binaryName: string;
  humanLabel: string;
  envOverride: string;
  triedPaths?: string[];
}): string {
  const install = getRuntimeInstallInfo(runtimeId);
  const installHint = install?.command
    ? `Install it with: ${install.command}.`
    : install?.link
      ? `Install it from: ${install.link}.`
      : `Install ${binaryName} and make it available on PATH.`;
  const envHint = `If it is already installed, set ${envOverride} to the absolute ${binaryName} path and retry.`;
  const tried = triedPaths.length > 0
    ? ` Resolver checked ${triedPaths.slice(0, 8).join(', ')}${triedPaths.length > 8 ? ', ...' : ''}.`
    : '';

  return `[runtime] ${humanLabel} is not installed — '${binaryName}' CLI was not found. ${installHint} ${envHint}${tried}`;
}
