import { constants } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const GATE_SCRIPTS = ['lint', 'test', 'typecheck'] as const;
const HOST_COMMANDS = new Set([
  '.', 'bash', 'bun', 'cargo', 'cd', 'cmd', 'corepack', 'cp', 'deno', 'echo',
  'export', 'false', 'go', 'make', 'mkdir', 'mv', 'node', 'npm', 'npx', 'pnpm',
  'powershell', 'printf', 'pwsh', 'python', 'python3', 'rm', 'set', 'sh', 'source',
  'test', 'touch', 'true', 'yarn', 'zsh',
]);
const MAX_SCRIPT_NESTING_DEPTH = 3;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type GateScriptName = typeof GATE_SCRIPTS[number];

interface PackageJsonShape {
  scripts?: Record<string, unknown>;
}

interface BinaryRequirement {
  local: boolean;
  name: string;
}

interface ScriptResolution {
  errors: string[];
  requirements: BinaryRequirement[];
}

export interface DependencyMaterializationVerification {
  missingBinaries: string[];
  requiredBinaries: string[];
  resolutionErrors: string[];
  scriptBinaries: Partial<Record<GateScriptName, string[]>>;
  topLevelEntryCount: number;
  unreadableFiles: string[];
  verifiedBinaries: string[];
}

export const DEPENDENCY_MATERIALIZATION_INCOMPLETE = 'dependency_materialization_incomplete';

export function isDependencyMaterializationIncomplete(
  verification: DependencyMaterializationVerification,
): boolean {
  return verification.missingBinaries.length > 0
    || verification.resolutionErrors.length > 0
    || verification.unreadableFiles.length > 0;
}

function formatIncompleteVerification(verification: DependencyMaterializationVerification): string {
  const details: string[] = [];
  if (verification.unreadableFiles.length > 0) {
    details.push(`Unreadable dependency manifest: ${verification.unreadableFiles.join(', ')}.`);
  }
  if (verification.resolutionErrors.length > 0) {
    details.push(`Dependency script resolution failed: ${verification.resolutionErrors.join('; ')}.`);
  }
  if (verification.missingBinaries.length > 0) {
    details.push(`Missing required dependency binaries: ${verification.missingBinaries.join(', ')}.`);
  }
  return details.join(' ') || 'Dependency materialization is incomplete.';
}

export class DependencyMaterializationIncompleteError extends Error {
  readonly code = DEPENDENCY_MATERIALIZATION_INCOMPLETE;

  constructor(
    public readonly verification: DependencyMaterializationVerification,
    public readonly imageGenerationInvalidated: boolean,
    public readonly imageInvalidationError: string | null,
  ) {
    super(`[${DEPENDENCY_MATERIALIZATION_INCOMPLETE}] ${formatIncompleteVerification(verification)}`);
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

function splitCommandSegments(script: string): string[] {
  const segments: string[] = [];
  let current = '';
  let escaped = false;
  let quote: '"' | '\'' | null = null;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== '\'') {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === '\'') {
      current += character;
      quote = character;
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (character === ';' || pair === '&&' || pair === '||') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if (pair === '&&' || pair === '||') index += 1;
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function commandStartIndex(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length && SHELL_ASSIGNMENT.test(tokens[index]!)) index += 1;
  if (tokens[index] !== 'env') return index;
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
  return index;
}

function firstNonFlag(tokens: string[], startIndex = 0): { index: number; token: string } | null {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith('-')) return { index, token };
  }
  return null;
}

function localRequirement(token: string | undefined, wrapper: string): ScriptResolution {
  if (!token) {
    return { requirements: [], errors: [`${wrapper} does not name a dependency binary`] };
  }
  return {
    requirements: [{ name: path.basename(token), local: true }],
    errors: [],
  };
}

function resolveNestedScript(
  scriptName: string | undefined,
  scripts: Record<string, unknown>,
  depth: number,
  visited: Set<string>,
): ScriptResolution {
  if (!scriptName) {
    return { requirements: [], errors: ['package script wrapper does not name a script'] };
  }
  if (visited.has(scriptName)) {
    return { requirements: [], errors: [`package.json script cycle at "${scriptName}"`] };
  }
  if (depth > MAX_SCRIPT_NESTING_DEPTH) {
    return {
      requirements: [],
      errors: [`package.json script nesting exceeds ${MAX_SCRIPT_NESTING_DEPTH} at "${scriptName}"`],
    };
  }
  const nested = scripts[scriptName];
  if (typeof nested !== 'string' || !nested.trim()) {
    return { requirements: [], errors: [`package.json script "${scriptName}" is missing`] };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(scriptName);
  return resolveScript(nested, scripts, depth, nextVisited);
}

function resolveSegment(
  segment: string,
  scripts: Record<string, unknown>,
  depth: number,
  visited: Set<string>,
): ScriptResolution {
  const tokens = scriptTokens(segment);
  const startIndex = commandStartIndex(tokens);
  const commandToken = tokens[startIndex];
  if (!commandToken) return { requirements: [], errors: [] };
  const command = path.basename(commandToken);
  const args = tokens.slice(startIndex + 1);

  if (command === 'npx') {
    return localRequirement(firstNonFlag(args)?.token, 'npx');
  }
  if (command === 'pnpm') {
    const execIndex = args.indexOf('exec');
    if (execIndex >= 0) {
      return localRequirement(firstNonFlag(args, execIndex + 1)?.token, 'pnpm exec');
    }
  }
  if (command === 'yarn') {
    return localRequirement(firstNonFlag(args)?.token, 'yarn');
  }
  if (command === 'npm') {
    const operation = firstNonFlag(args);
    if (operation?.token === 'run') {
      const scriptName = firstNonFlag(args, operation.index + 1)?.token;
      return resolveNestedScript(scriptName, scripts, depth + 1, visited);
    }
  }
  if (command === 'node') {
    const inlineRun = args.find((token) => token.startsWith('--run='));
    if (inlineRun) {
      return resolveNestedScript(inlineRun.slice('--run='.length), scripts, depth + 1, visited);
    }
    const runIndex = args.indexOf('--run');
    if (runIndex >= 0) {
      return resolveNestedScript(firstNonFlag(args, runIndex + 1)?.token, scripts, depth + 1, visited);
    }
  }

  return {
    requirements: [{ name: command, local: !HOST_COMMANDS.has(command) }],
    errors: [],
  };
}

function resolveScript(
  script: string,
  scripts: Record<string, unknown>,
  depth: number,
  visited: Set<string>,
): ScriptResolution {
  const resolution: ScriptResolution = { requirements: [], errors: [] };
  for (const segment of splitCommandSegments(script)) {
    const segmentResolution = resolveSegment(segment, scripts, depth, visited);
    resolution.requirements.push(...segmentResolution.requirements);
    resolution.errors.push(...segmentResolution.errors);
  }
  return resolution;
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

async function topLevelEntryCount(workspacePath: string): Promise<number> {
  return readdir(path.join(workspacePath, 'node_modules'))
    .then((entries) => entries.length)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
}

export async function verifyDependencyMaterialization(
  workspacePath: string,
): Promise<DependencyMaterializationVerification> {
  const entryCount = await topLevelEntryCount(workspacePath);
  let packageJson: PackageJsonShape;
  try {
    const parsed = JSON.parse(
      await readFile(path.join(workspacePath, 'package.json'), 'utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('package.json root must be an object');
    }
    packageJson = parsed as PackageJsonShape;
  } catch {
    return {
      missingBinaries: [],
      requiredBinaries: [],
      resolutionErrors: [],
      scriptBinaries: {},
      topLevelEntryCount: entryCount,
      unreadableFiles: ['package.json'],
      verifiedBinaries: [],
    };
  }

  const scripts = packageJson.scripts;
  if (scripts !== undefined && (!scripts || typeof scripts !== 'object' || Array.isArray(scripts))) {
    return {
      missingBinaries: [],
      requiredBinaries: [],
      resolutionErrors: [],
      scriptBinaries: {},
      topLevelEntryCount: entryCount,
      unreadableFiles: ['package.json'],
      verifiedBinaries: [],
    };
  }
  const packageScripts = scripts ?? {};
  const requirements = new Map<string, boolean>();
  const resolutionErrors: string[] = [];
  const scriptBinaries: Partial<Record<GateScriptName, string[]>> = {};
  for (const scriptName of GATE_SCRIPTS) {
    const script = packageScripts[scriptName];
    if (typeof script !== 'string' || !script.trim()) continue;
    const resolution = resolveScript(script, packageScripts, 0, new Set([scriptName]));
    const binaries = [...new Set(resolution.requirements.map((requirement) => requirement.name))].sort();
    if (binaries.length > 0) scriptBinaries[scriptName] = binaries;
    for (const requirement of resolution.requirements) {
      requirements.set(requirement.name, (requirements.get(requirement.name) ?? false) || requirement.local);
    }
    resolutionErrors.push(...resolution.errors.map((error) => `${scriptName}: ${error}`));
  }

  const requiredBinaries = [...requirements.keys()].sort();
  const verifiedBinaries: string[] = [];
  const missingBinaries: string[] = [];
  for (const binary of requiredBinaries) {
    if (!requirements.get(binary) || await localBinaryExists(workspacePath, binary)) {
      verifiedBinaries.push(binary);
    } else {
      missingBinaries.push(binary);
    }
  }

  return {
    missingBinaries,
    requiredBinaries,
    resolutionErrors,
    scriptBinaries,
    topLevelEntryCount: entryCount,
    unreadableFiles: [],
    verifiedBinaries,
  };
}
