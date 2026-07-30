import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(input: string): unknown };

type QualityMode = 'quality' | 'stable' | 'cheap';

type SessionConfig = {
  trigger: string;
  max_loops: number;
  quality_mode: QualityMode;
  cost_cap_usd: number;
  stop_on_cost_cap: boolean;
};

type TargetConfig = {
  repo_path: string;
  target_ref: string;
  allow_dirty_override: boolean;
  candidate_refs?: string[];
};

type BenchmarkConfig = {
  dataset: string;
  slice: string;
  search_mode?: 'bm25' | 'hybrid' | 'semantic' | 'rrf';
  embed_before_scoring?: boolean;
  answerable_categories: number[];
  import_flags: string[];
};

type ProvidersConfig = {
  llm?: string;
  embed?: string;
};

type ModelSet = {
  synthesis: string;
  benchmark_answer: string;
  literature: string;
  tagging: string;
};

type Config = {
  session: SessionConfig;
  target: TargetConfig;
  benchmark: BenchmarkConfig;
  providers?: ProvidersConfig;
  models: Record<QualityMode, ModelSet>;
};

type Question = {
  question: string;
  answer: string | number;
  evidence: string[];
  category: number;
};

type LoopTarget = {
  loopIndex: number;
  label: string;
  ref: string;
  kind: 'baseline_main' | 'candidate_branch';
};

type SearchResult = {
  content?: string;
  snippet?: string;
  source_file?: string;
  source_section?: string;
  temporal_anchor?: string;
};

type AskResult = {
  answer?: string;
  degraded?: boolean;
  reason?: string;
  model?: string;
  packed_tokens?: number;
  candidate_count?: number;
};

type QuestionResult = {
  question: string;
  expected: string;
  category: number;
  evidence: string[];
  evidenceHit: boolean;
  topSection: string;
  topSource: string;
  askAnswer: string;
  degraded: boolean;
  reason: string;
  exactMatch: boolean;
  tokenF1: number;
  packedTokens: number;
  estimatedCostUsd: number;
};

type LoopSummary = {
  loopIndex: number;
  label: string;
  ref: string;
  sha: string;
  kind: 'baseline_main' | 'candidate_branch';
  worktreePath: string;
  binaryPath: string;
  dbPath: string;
  importDurationSeconds: number;
  stats: Record<string, unknown>;
  model: string;
  questionResults: QuestionResult[];
  evidenceHits: number;
  nonDegradedAnswers: number;
  exactMatches: number;
  avgTokenF1: number;
  estimatedCostUsd: number;
};

type CliOptions = {
  configPath: string;
  trigger?: string;
  maxLoops?: number;
  qualityMode?: QualityMode;
  costCapUsd?: number;
  allowDirtyTarget?: boolean;
  benchmarkAnswerModel?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    configPath: path.resolve(process.cwd(), 'config/research/cortex-autoresearch.yaml'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--config' && next) {
      opts.configPath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === '--trigger' && next) {
      opts.trigger = next;
      i += 1;
    } else if (arg === '--max-loops' && next) {
      opts.maxLoops = Number(next);
      i += 1;
    } else if (arg === '--quality-mode' && next) {
      opts.qualityMode = next as QualityMode;
      i += 1;
    } else if (arg === '--cost-cap-usd' && next) {
      opts.costCapUsd = Number(next);
      i += 1;
    } else if (arg === '--allow-dirty-target') {
      opts.allowDirtyTarget = true;
    } else if (arg === '--benchmark-answer-model' && next) {
      opts.benchmarkAnswerModel = next;
      i += 1;
    }
  }

  return opts;
}

function readConfig(configPath: string): Config {
  const raw = fs.readFileSync(configPath, 'utf8');
  return yaml.load(raw) as Config;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runCmd(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): string {
  return execFileSync(command, args, {
    cwd: options?.cwd,
    env: options?.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runCmdJson<T>(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): T {
  return JSON.parse(runCmd(command, args, options)) as T;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function nowRunId(): string {
  const iso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return iso.replace(/[:]/g, '-');
}

function assertCleanTargetRepo(target: TargetConfig, allowDirtyTarget = false): void {
  if (target.allow_dirty_override || allowDirtyTarget) return;
  const status = runCmd('git', ['-C', target.repo_path, 'status', '--short']);
  if (status.trim()) {
    throw new Error(
      `Target repo is dirty at ${target.repo_path}. Re-run with a clean repo or allow_dirty_override.`,
    );
  }
}

function resolveRef(repoPath: string, ref: string): string {
  return runCmd('git', ['-C', repoPath, 'rev-parse', ref]).trim();
}

function createDetachedWorktree(repoPath: string, sha: string, label: string, runId: string): string {
  const worktreePath = path.join('/tmp', `${slugify(label)}-${slugify(runId)}`);
  runCmd('git', ['-C', repoPath, 'worktree', 'add', '--detach', worktreePath, sha]);
  return worktreePath;
}

function buildBinary(worktreePath: string, outputPath: string): void {
  ensureDir(path.dirname(outputPath));
  runCmd('go', ['build', '-o', outputPath, './cmd/cortex'], { cwd: worktreePath });
}

async function ensureDataset(runDir: string): Promise<string> {
  const datasetDir = path.join(runDir, 'inputs');
  ensureDir(datasetDir);
  const datasetPath = path.join(datasetDir, 'locomo10.json');
  if (!fs.existsSync(datasetPath)) {
    const response = await fetch(
      'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json',
    );
    if (!response.ok) {
      throw new Error(`Failed to download LoCoMo dataset: ${response.status}`);
    }
    const text = await response.text();
    fs.writeFileSync(datasetPath, text);
  }
  return datasetPath;
}

function renderCorpus(datasetPath: string, runDir: string, benchmark: BenchmarkConfig): Question[] {
  const corpusDir = path.join(runDir, 'corpus');
  ensureDir(corpusDir);
  const raw = fs.readFileSync(datasetPath, 'utf8');
  const data = JSON.parse(raw) as Array<{
    sample_id: string;
    conversation: Record<string, unknown>;
    qa: Question[];
  }>;

  for (const item of data) {
    const conversation = item.conversation as Record<string, unknown>;
    const lines: string[] = [];
    lines.push(`# ${item.sample_id}`);
    lines.push('');
    lines.push(`Participants: ${conversation.speaker_a}, ${conversation.speaker_b}`);
    lines.push('');

    for (let i = 1; i <= 16; i += 1) {
      const date = conversation[`session_${i}_date_time`];
      const turns = conversation[`session_${i}`];
      if (!date || !Array.isArray(turns)) continue;
      lines.push(`## Session ${i} - ${String(date)}`);
      lines.push('');
      for (const turn of turns as Array<Record<string, unknown>>) {
        const dia = turn.dia_id ? ` (${String(turn.dia_id)})` : '';
        lines.push(`${String(turn.speaker)}${dia}: ${String(turn.text ?? '')}`);
        if (Array.isArray(turn.img_url) && turn.img_url.length > 0) {
          lines.push(`Image URLs: ${turn.img_url.map(String).join(', ')}`);
        }
        if (turn.blip_caption) lines.push(`Image caption: ${String(turn.blip_caption)}`);
        if (turn.query) lines.push(`Image query: ${String(turn.query)}`);
        lines.push('');
      }
    }

    fs.writeFileSync(path.join(corpusDir, `${item.sample_id}.md`), lines.join('\n'));
  }

  const conv30 = data.find((item) => item.sample_id === 'conv-30');
  if (!conv30) throw new Error('conv-30 not found in dataset');

  let questions = conv30.qa.filter((q) => benchmark.answerable_categories.includes(q.category));
  if (benchmark.slice === 'conv30_smoke') {
    questions = questions.slice(0, 3);
  }

  fs.writeFileSync(path.join(runDir, 'smoke-questions.json'), JSON.stringify(questions, null, 2));
  return questions;
}

function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[\d+\]/g, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeAnswer(value: string): string[] {
  const normalized = normalizeAnswer(value);
  return normalized ? normalized.split(' ') : [];
}

function tokenF1(predicted: string, expected: string): number {
  const predTokens = tokenizeAnswer(predicted);
  const expTokens = tokenizeAnswer(expected);
  if (predTokens.length === 0 && expTokens.length === 0) return 1;
  if (predTokens.length === 0 || expTokens.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const token of expTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  let overlap = 0;
  for (const token of predTokens) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(token, remaining - 1);
    }
  }

  if (overlap === 0) return 0;
  const precision = overlap / predTokens.length;
  const recall = overlap / expTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

function estimateCostUsd(model: string, packedTokens: number, answer: string): number {
  const pricing: Record<string, { inputPerM: number; outputPerM: number }> = {
    'openrouter/google/gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
    'openrouter/google/gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
    'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
    'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
    'gemini-3.1-pro-preview': { inputPerM: 1, outputPerM: 6 },
    'gemini-3-flash-preview': { inputPerM: 0.25, outputPerM: 1.5 },
    'gemini-3.1-flash-lite-preview': { inputPerM: 0.13, outputPerM: 0.75 },
  };
  const rate = pricing[model];
  if (!rate) return 0;
  const outputTokens = Math.ceil(answer.length / 4);
  return (packedTokens / 1_000_000) * rate.inputPerM + (outputTokens / 1_000_000) * rate.outputPerM;
}

function embedWithTimeout(dbPath: string, embedProvider: string): string {
  const model = embedProvider.startsWith('ollama/')
    ? embedProvider.slice('ollama/'.length)
    : embedProvider;
  return runCmd('python3', [
    path.resolve(process.cwd(), 'scripts/research/embed_with_timeout.py'),
    dbPath,
    model,
    '8',
  ]);
}

function runQuestionSet(
  binaryPath: string,
  dbPath: string,
  questions: Question[],
  model: string,
  searchMode: string,
  embedProvider?: string,
): QuestionResult[] {
  return questions.map((question) => {
    const searchArgs = [
      '--db',
      dbPath,
      'search',
      question.question,
      '--mode',
      searchMode,
      '--limit',
      '5',
      '--json',
    ];
    if (embedProvider && searchMode !== 'bm25') {
      searchArgs.splice(searchArgs.length - 1, 0, '--embed', embedProvider);
    }
    const search = runCmdJson<SearchResult[]>(binaryPath, searchArgs);

    const askArgs = [
      '--db',
      dbPath,
      'ask',
      question.question,
      '--mode',
      searchMode,
      '--budget',
      '600',
      '--model',
      model,
      '--json',
    ];
    if (embedProvider && searchMode !== 'bm25') {
      askArgs.splice(askArgs.length - 1, 0, '--embed', embedProvider);
    }
    const ask = runCmdJson<AskResult>(binaryPath, askArgs);
    const evidenceHit = search.slice(0, 5).some((result) =>
      question.evidence.some(
        (evidence) =>
          (result.content ?? '').includes(evidence) || (result.snippet ?? '').includes(evidence),
      ),
    );
    const answer = ask.answer ?? '';
    const expected = String(question.answer);
    const exactMatch = normalizeAnswer(answer) === normalizeAnswer(expected);
    const answerTokenF1 = tokenF1(answer, expected);
    return {
      question: question.question,
      expected,
      category: question.category,
      evidence: question.evidence,
      evidenceHit,
      topSection: search[0]?.source_section ?? '',
      topSource: search[0]?.source_file ?? '',
      askAnswer: answer,
      degraded: Boolean(ask.degraded),
      reason: ask.reason ?? '',
      exactMatch,
      tokenF1: answerTokenF1,
      packedTokens: ask.packed_tokens ?? 0,
      estimatedCostUsd: estimateCostUsd(model, ask.packed_tokens ?? 0, answer),
    };
  });
}

function buildLoopTargets(config: Config, maxLoops: number): LoopTarget[] {
  const targets: LoopTarget[] = [
    {
      loopIndex: 1,
      label: 'baseline-main',
      ref: config.target.target_ref,
      kind: 'baseline_main',
    },
  ];

  const candidates = config.target.candidate_refs ?? [];
  for (const candidate of candidates) {
    if (targets.length >= maxLoops) break;
    targets.push({
      loopIndex: targets.length + 1,
      label: `candidate-${slugify(candidate)}`,
      ref: candidate,
      kind: 'candidate_branch',
    });
  }

  return targets;
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSessionReport(
  filePath: string,
  runId: string,
  loops: LoopSummary[],
  selectedModel: string,
  estimatedCostUsd: number,
): void {
  const lines: string[] = [];
  lines.push(`# Cortex AutoResearch Session — ${runId}`);
  lines.push('');
  lines.push(`- loops run: ${loops.length}`);
  lines.push(`- measured model: \`${selectedModel}\``);
  lines.push(`- estimated token cost: \`$${estimatedCostUsd.toFixed(4)}\``);
  lines.push('');

  for (const loop of loops) {
    lines.push(`## Loop ${loop.loopIndex} — ${loop.label}`);
    lines.push('');
    lines.push(`- ref: \`${loop.ref}\``);
    lines.push(`- sha: \`${loop.sha.slice(0, 7)}\``);
    lines.push(`- import duration: \`${loop.importDurationSeconds.toFixed(2)}s\``);
    lines.push(`- evidence hits: \`${loop.evidenceHits}/${loop.questionResults.length}\``);
    lines.push(`- non-degraded answers: \`${loop.nonDegradedAnswers}/${loop.questionResults.length}\``);
    lines.push(`- exact matches: \`${loop.exactMatches}/${loop.questionResults.length}\``);
    lines.push(`- avg token F1: \`${loop.avgTokenF1.toFixed(4)}\``);
    lines.push(`- estimated cost: \`$${loop.estimatedCostUsd.toFixed(4)}\``);
    lines.push('');
    for (const result of loop.questionResults) {
      lines.push(`### ${result.question}`);
      lines.push('');
      lines.push(`- expected: \`${result.expected}\``);
      lines.push(`- evidence hit: \`${result.evidenceHit}\``);
      lines.push(`- degraded: \`${result.degraded}\``);
      lines.push(`- exact match: \`${result.exactMatch}\``);
      lines.push(`- token F1: \`${result.tokenF1.toFixed(4)}\``);
      if (result.reason) {
        lines.push(`- reason: \`${result.reason}\``);
      }
      if (result.topSection) {
        lines.push(`- top section: \`${result.topSection}\``);
      }
      lines.push(`- answer: ${result.askAnswer}`);
      lines.push('');
    }
  }

  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const config = readConfig(cli.configPath);

  if (cli.trigger) config.session.trigger = cli.trigger;
  if (cli.maxLoops) config.session.max_loops = cli.maxLoops;
  if (cli.qualityMode) config.session.quality_mode = cli.qualityMode;
  if (cli.costCapUsd) config.session.cost_cap_usd = cli.costCapUsd;

  assertCleanTargetRepo(config.target, cli.allowDirtyTarget);
  runCmd('git', ['-C', config.target.repo_path, 'fetch', 'origin']);

  const runId = nowRunId();
  const runDir = path.resolve(
    process.cwd(),
    'artifacts/research/cortex-autoresearch/runs',
    runId,
  );
  ensureDir(runDir);

  const datasetPath = await ensureDataset(runDir);
  const questions = renderCorpus(datasetPath, runDir, config.benchmark);
  const selectedModel =
    cli.benchmarkAnswerModel ?? config.models[config.session.quality_mode].benchmark_answer;
  const searchMode = config.benchmark.search_mode ?? 'bm25';
  const embedProvider = config.providers?.embed;
  const loopTargets = buildLoopTargets(config, config.session.max_loops);
  const loops: LoopSummary[] = [];
  let runningCost = 0;
  ensureDir(path.join(runDir, 'benchmark'));
  ensureDir(path.join(runDir, 'binaries'));
  ensureDir(path.join(runDir, 'db'));

  writeJson(path.join(runDir, 'manifest.json'), {
    run_id: runId,
    trigger: config.session.trigger,
    target_repo: config.target.repo_path,
    target_ref: config.target.target_ref,
    quality_mode: config.session.quality_mode,
    selected_model: selectedModel,
    search_mode: searchMode,
    embed_provider: embedProvider ?? '',
    cost_cap_usd: config.session.cost_cap_usd,
    max_loops: config.session.max_loops,
  });

  for (const target of loopTargets) {
    if (config.session.stop_on_cost_cap && runningCost >= config.session.cost_cap_usd) break;

    const sha = resolveRef(config.target.repo_path, target.kind === 'baseline_main' ? `origin/${target.ref}` : target.ref);
    const worktreePath = createDetachedWorktree(config.target.repo_path, sha, target.label, runId);
    const binaryPath = path.join(runDir, 'binaries', target.label, 'cortex');
    buildBinary(worktreePath, binaryPath);

    const dbPath = path.join(runDir, 'db', `${target.label}.db`);
    ensureDir(path.dirname(dbPath));

    const importStartedAt = Date.now();
    const importArgs = [
      '--db',
      dbPath,
      'import',
      path.join(runDir, 'corpus'),
      ...config.benchmark.import_flags,
    ];
    const importOutput = runCmd(binaryPath, importArgs);
    const importDurationSeconds = (Date.now() - importStartedAt) / 1000;
    fs.writeFileSync(path.join(runDir, 'benchmark', `${target.label}-import.log`), importOutput);

    if (embedProvider && config.benchmark.embed_before_scoring !== false && searchMode !== 'bm25') {
      const embedOutput = embedWithTimeout(dbPath, embedProvider);
      fs.writeFileSync(path.join(runDir, 'benchmark', `${target.label}-embed.log`), embedOutput);
    }

    const stats = runCmdJson<Record<string, unknown>>(binaryPath, ['--db', dbPath, 'stats']);
    const questionResults = runQuestionSet(
      binaryPath,
      dbPath,
      questions,
      selectedModel,
      searchMode,
      embedProvider,
    );
    const evidenceHits = questionResults.filter((result) => result.evidenceHit).length;
    const nonDegradedAnswers = questionResults.filter((result) => !result.degraded).length;
    const exactMatches = questionResults.filter((result) => result.exactMatch).length;
    const avgTokenF1 =
      questionResults.reduce((sum, result) => sum + result.tokenF1, 0) / questionResults.length;
    const estimatedCostUsd = questionResults.reduce(
      (sum, result) => sum + result.estimatedCostUsd,
      0,
    );
    runningCost += estimatedCostUsd;

    const summary: LoopSummary = {
      loopIndex: target.loopIndex,
      label: target.label,
      ref: target.ref,
      sha,
      kind: target.kind,
      worktreePath,
      binaryPath,
      dbPath,
      importDurationSeconds,
      stats,
      model: selectedModel,
      questionResults,
      evidenceHits,
      nonDegradedAnswers,
      exactMatches,
      avgTokenF1,
      estimatedCostUsd,
    };
    loops.push(summary);
    writeJson(path.join(runDir, 'benchmark', `${target.label}.json`), summary);
  }

  const sessionDoc = path.resolve(
    process.cwd(),
    'artifacts/research/cortex-autoresearch/sessions',
    `${runId}.md`,
  );
  writeSessionReport(sessionDoc, runId, loops, selectedModel, runningCost);

  const scoreboardPath = path.resolve(
    process.cwd(),
    'artifacts/research/cortex-autoresearch/scoreboard.tsv',
  );
  ensureDir(path.dirname(scoreboardPath));
  if (!fs.existsSync(scoreboardPath)) {
    fs.writeFileSync(
      scoreboardPath,
      'run_id\tlabel\tsha\tmodel\tevidence_hits\tnon_degraded\texact_matches\tavg_token_f1\testimated_cost_usd\n',
    );
  }
  for (const loop of loops) {
    fs.appendFileSync(
      scoreboardPath,
      [
        runId,
        loop.label,
        loop.sha.slice(0, 7),
        loop.model,
        `${loop.evidenceHits}/${loop.questionResults.length}`,
        `${loop.nonDegradedAnswers}/${loop.questionResults.length}`,
        `${loop.exactMatches}/${loop.questionResults.length}`,
        loop.avgTokenF1.toFixed(4),
        loop.estimatedCostUsd.toFixed(4),
      ].join('\t') + '\n',
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        run_id: runId,
        selected_model: selectedModel,
        loops: loops.map((loop) => ({
          label: loop.label,
          ref: loop.ref,
          sha: loop.sha.slice(0, 7),
          evidence_hits: `${loop.evidenceHits}/${loop.questionResults.length}`,
          non_degraded: `${loop.nonDegradedAnswers}/${loop.questionResults.length}`,
          exact_matches: `${loop.exactMatches}/${loop.questionResults.length}`,
          avg_token_f1: loop.avgTokenF1.toFixed(4),
          estimated_cost_usd: loop.estimatedCostUsd.toFixed(4),
        })),
        session_doc: sessionDoc,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
