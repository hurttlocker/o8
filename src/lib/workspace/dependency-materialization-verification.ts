import { constants } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const GATE_SCRIPTS = ['lint', 'test', 'typecheck'] as const;
const HOST_BINARIES = new Set([
  'bash', 'bun', 'cargo', 'cmd', 'corepack', 'deno', 'go', 'make', 'node',
  'npm', 'npx', 'pnpm', 'powershell', 'pwsh', 'python', 'python3', 'sh', 'yarn',
  'zsh',
]);
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type GateScriptName = typeof GATE_SCRIPTS[number];

interface PackageJsonShape {
  scripts?: Partial<Record<GateScriptName, unknown>>;
}

export interface DependencyMaterializationVerification {
  missingBinaries: string[];
  requiredBinaries: string[];
  scriptBinaries: Partial<Record<GateScriptName, string>>;
  topLevelEntryCount: number;
  verifiedBinaries: string[];
}

export const DEPENDENCY_MATERIALIZATION_INCOMPLETE = 'dependency_materialization_incomplete';

export class DependencyMaterializationIncompleteError extends Error {
  readonly code = DEPENDENCY_MATERIALIZATION_INCOMPLETE;

  constructor(
    public readonly verification: DependencyMaterializationVerification,
    public readonly imageGenerationInvalidated: boolean,
    public readonly imageInvalidationError: string | null,
  ) {
    super(
      `[${DEPENDENCY_MATERIALIZATION_INCOMPLETE}] Missing required dependency binaries: ${verification.missingBinaries.join(', ')}.`,
    );
    this.name = 'DependencyMaterializationIncompleteError';
  }
}

function unquoteToken(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function scriptTokens(script: string): string[] {
  return (script.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/g) ?? [])
    .map(unquoteToken);
}

function firstScriptBinary(script: string): string | null {
  const tokens = scriptTokens(script);
  let index = 0;
  if (tokens[index] === 'env') {
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token === '-u' || token === '--unset') {
        index += 2;
        continue;
      }
      if (token.startsWith('-') || SHELL_ASSIGNMENT.test(token)) {
        index += 1;
        continue;
      }
      break;
    }
  } else {
    while (index < tokens.length && SHELL_ASSIGNMENT.test(tokens[index]!)) index += 1;
  }
  const token = tokens[index];
  return token ? path.basename(token) : null;
}

async function localBinaryExists(workspacePath: string, binary: string): Promise<boolean> {
  const binRoot = path.join(workspacePath, 'node_modules', '.bin');
  const candidates = process.platform === 'win32'
    ? [binary, `${binary}.cmd`, `${binary}.exe`, `${binary}.ps1`]
    : [binary];
  for (const candidate of candidates) {
    try {
      await access(
        path.join(binRoot, candidate),
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      return true;
    } catch {
      // Try the next platform-specific shim.
    }
  }
  return false;
}

export async function verifyDependencyMaterialization(
  workspacePath: string,
): Promise<DependencyMaterializationVerification> {
  const packageJson = JSON.parse(
    await readFile(path.join(workspacePath, 'package.json'), 'utf8'),
  ) as PackageJsonShape;
  const scriptBinaries: Partial<Record<GateScriptName, string>> = {};
  for (const scriptName of GATE_SCRIPTS) {
    const script = packageJson.scripts?.[scriptName];
    if (typeof script !== 'string' || !script.trim()) continue;
    const binary = firstScriptBinary(script);
    if (binary) scriptBinaries[scriptName] = binary;
  }

  const requiredBinaries = [...new Set(Object.values(scriptBinaries))].sort();
  const verifiedBinaries: string[] = [];
  const missingBinaries: string[] = [];
  for (const binary of requiredBinaries) {
    // Package scripts resolve local shims first, while runtimes and package managers
    // such as node/npm are provided by the launch environment rather than .bin.
    if (await localBinaryExists(workspacePath, binary) || HOST_BINARIES.has(binary)) {
      verifiedBinaries.push(binary);
    } else {
      missingBinaries.push(binary);
    }
  }

  const topLevelEntryCount = await readdir(path.join(workspacePath, 'node_modules'))
    .then((entries) => entries.length)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
  return {
    missingBinaries,
    requiredBinaries,
    scriptBinaries,
    topLevelEntryCount,
    verifiedBinaries,
  };
}
