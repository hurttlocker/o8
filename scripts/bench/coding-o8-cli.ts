import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const O8_BENCH_CLI_OVERRIDE_ENV = 'O8_BENCH_O8_CLI';

export type O8CliSource = 'override' | 'repo' | 'path';

export interface O8CliResolutionReceipt {
  resolvedPath: string;
  source: O8CliSource;
  repoCliPath: string;
  repoCliExists: boolean;
  capabilities: {
    existingBranchPolicy: true;
  };
}

type O8CliSelection = Omit<O8CliResolutionReceipt, 'capabilities'>;

function executableRealPath(candidate: string): string | null {
  try {
    const resolved = fs.realpathSync(candidate);
    if (!fs.statSync(resolved).isFile()) return null;
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function executableFromPath(command: string, cwd: string, envPath: string | undefined): string | null {
  for (const entry of (envPath ?? '').split(path.delimiter)) {
    const directory = entry ? path.resolve(cwd, entry) : cwd;
    const resolved = executableRealPath(path.join(directory, command));
    if (resolved) return resolved;
  }
  return null;
}

function selectO8Cli(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): O8CliSelection {
  const repoCliPath = path.join(path.resolve(repoRoot), 'cli', 'dist', 'o8.mjs');
  const repoCliExists = fs.existsSync(repoCliPath);
  const override = env[O8_BENCH_CLI_OVERRIDE_ENV]?.trim();
  if (override) {
    const overridePath = path.isAbsolute(override) ? override : path.resolve(repoRoot, override);
    const resolvedPath = executableRealPath(overridePath);
    if (!resolvedPath) {
      throw new Error(
        `${O8_BENCH_CLI_OVERRIDE_ENV} must point to an executable o8 CLI; ` +
        `could not execute ${overridePath}`,
      );
    }
    return { resolvedPath, source: 'override', repoCliPath, repoCliExists };
  }

  if (repoCliExists) {
    const resolvedPath = executableRealPath(repoCliPath);
    if (!resolvedPath) {
      throw new Error(`repo o8 CLI is not executable at ${repoCliPath}; run npm run build:cli`);
    }
    return { resolvedPath, source: 'repo', repoCliPath, repoCliExists };
  }

  const resolvedPath = executableFromPath('o8', repoRoot, env.PATH);
  if (!resolvedPath) {
    throw new Error(
      `repo o8 CLI is missing at ${repoCliPath}, and no executable o8 CLI was found on PATH; ` +
      'run npm run build:cli or set O8_BENCH_O8_CLI',
    );
  }
  return { resolvedPath, source: 'path', repoCliPath, repoCliExists };
}

export function preflightO8Cli(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): O8CliResolutionReceipt {
  const selected = selectO8Cli(repoRoot, env);
  const help = spawnSync(selected.resolvedPath, ['mission', 'create', '--help'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const errorCode = help.error && 'code' in help.error ? String(help.error.code) : null;
  if (help.status !== 0 || errorCode) {
    throw new Error(
      `resolved o8 CLI at ${selected.resolvedPath} (${selected.source}) could not be inspected ` +
      `during preflight${errorCode ? `: ${errorCode}` : ''}`,
    );
  }
  const helpText = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
  if (!helpText.includes('--existingBranchPolicy')) {
    throw new Error(
      `resolved o8 CLI at ${selected.resolvedPath} (${selected.source}) lacks the required ` +
      'mission create --existingBranchPolicy capability; run npm run build:cli or set ' +
      `${O8_BENCH_CLI_OVERRIDE_ENV} to a compatible CLI`,
    );
  }
  return {
    ...selected,
    capabilities: { existingBranchPolicy: true },
  };
}

export function o8CliPreflightSummary(receipt: O8CliResolutionReceipt): string {
  const repoStatus = receipt.repoCliExists
    ? `repo CLI present at ${receipt.repoCliPath}`
    : `repo CLI missing at ${receipt.repoCliPath}`;
  return `cli=${receipt.resolvedPath}, cliSource=${receipt.source}, ${repoStatus}`;
}
