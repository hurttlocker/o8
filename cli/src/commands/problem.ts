import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

interface ProblemEvidence {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceKind: string;
  packetId: string;
  observedAt: string;
}

interface ProblemRemedy {
  id: string;
  sequence: number;
  taskId: string | null;
  packetId: string | null;
  status: string;
}

interface ProblemDossier {
  id: string;
  projectId: string;
  repoPath: string;
  painStatement: string;
  status: string;
  occurrenceCount: number;
  comparableExposureCount: number;
  impactBand: string;
  evidenceConfidence: string;
  linkedTaskId: string | null;
  closureContract: { requiredComparableExposures: number };
  firstObservedAt: string;
  lastObservedAt: string;
  evidence: ProblemEvidence[];
  remedies: ProblemRemedy[];
}

interface ProblemDossierResponse {
  schema: 'o8/problem-dossiers/v1';
  dossiers: ProblemDossier[];
  summary: Record<string, number>;
  metrics: Record<string, unknown>;
}

function readFlagValue(rest: string[], name: string): string | null {
  const index = rest.indexOf(name);
  const value = index >= 0 ? rest[index + 1] : null;
  return value && !value.startsWith('-') ? value : null;
}

function positional(rest: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value) continue;
    if (value === '--project' || value === '--repo') {
      index += 1;
    } else if (!value.startsWith('-')) {
      values.push(value);
    }
  }
  return values;
}

async function readProblems(rest: string[]): Promise<ProblemDossierResponse> {
  const params = new URLSearchParams();
  if (rest.includes('--all')) params.set('includeSuppressed', 'true');
  const projectId = readFlagValue(rest, '--project');
  if (projectId) params.set('projectId', projectId);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const response = await apiFetch<ProblemDossierResponse>(resolveConfig(), `/api/panel/problem-dossiers${suffix}`);
  if (!response.data) {
    throw new CliError('invalid_response', 'Server returned an empty problem dossier response.', EXIT.INVALID_ARGS);
  }
  return response.data;
}

function printProblem(dossier: ProblemDossier): void {
  printHumanHeading('problem dossier');
  printHumanKv([
    ['id', dossier.id],
    ['status', dossier.status],
    ['impact', dossier.impactBand],
    ['confidence', dossier.evidenceConfidence],
    ['signals', String(dossier.occurrenceCount)],
    ['clean exposures', `${dossier.comparableExposureCount}/${dossier.closureContract.requiredComparableExposures}`],
    ['task', dossier.linkedTaskId ?? '(none)'],
    ['repo', dossier.repoPath],
  ]);
  process.stdout.write(`\n${dossier.painStatement}\n`);
  if (dossier.evidence.length > 0) {
    printHumanHeading('evidence');
    for (const evidence of dossier.evidence) {
      process.stdout.write(`  ${evidence.sourceKind}  ${evidence.packetId}  ${evidence.observedAt}\n`);
    }
  }
}

export async function runProblem(mode: OutputMode, subcommand: string | undefined, rest: string[]): Promise<number> {
  if (subcommand !== 'list' && subcommand !== 'show') {
    throw new CliError(
      'unknown_problem_subcommand',
      `Unknown problem subcommand: ${subcommand ?? '(none)'}`,
      EXIT.INVALID_ARGS,
      'Use `o8 problem list [--all]` or `o8 problem show <id>`.',
    );
  }
  const response = await readProblems(rest);
  if (subcommand === 'show') {
    const id = positional(rest)[0];
    if (!id) throw new CliError('invalid_args', 'o8 problem show requires a dossier id.', EXIT.INVALID_ARGS);
    const dossier = response.dossiers.find((candidate) => candidate.id === id);
    if (!dossier) throw new CliError('problem_not_found', `Problem dossier not found: ${id}`, EXIT.NOT_FOUND);
    if (mode.human) printProblem(dossier);
    else printJson({ schema: 'o8/cli/problem.show/v1', dossier });
    return EXIT.OK;
  }

  const repoPath = readFlagValue(rest, '--repo');
  const dossiers = repoPath
    ? response.dossiers.filter((dossier) => dossier.repoPath === repoPath)
    : response.dossiers;
  if (mode.human) {
    printHumanHeading('recurring problems');
    if (dossiers.length === 0) process.stdout.write('  (none)\n');
    for (const dossier of dossiers) {
      process.stdout.write(`  ${dossier.id}  ${dossier.status}  ${dossier.occurrenceCount} signals\n`);
      process.stdout.write(`    ${dossier.painStatement}\n`);
    }
  } else {
    printJson({ schema: 'o8/cli/problem.list/v1', dossiers, summary: response.summary, metrics: response.metrics });
  }
  return EXIT.OK;
}
