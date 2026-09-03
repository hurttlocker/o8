// o8 benchmark-suite entrypoint; see tests/bench/README.md for usage.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CATEGORIES = [
  'ownership',
  'decisions',
  'processes',
  'incidents',
  'specs',
  'cross-repo',
  'literal-lookup',
];

const SCORECARD_DIR = path.resolve(process.env.O8_BENCH_SCORECARD_DIR || path.join(process.cwd(), 'tests/bench/scorecards'));
const LATEST_DIR = path.resolve(process.env.O8_BENCH_LATEST_DIR || path.join(process.cwd(), 'tests/bench/latest'));
const PRIOR_SCORECARD_DIRS = (process.env.O8_BENCH_PRIOR_SCORECARD_DIRS || SCORECARD_DIR)
  .split(path.delimiter)
  .filter(Boolean)
  .map((directory) => path.resolve(directory));
const OPERATOR_TRIGGERED_NOT_RUN = 'operator-triggered — not run this release';

function readJsonOptional(filePath) {
  try {
    return { data: JSON.parse(fs.readFileSync(filePath, 'utf8')), note: null };
  } catch (err) {
    return {
      data: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value)) {
    return value.value;
  }
  return null;
}

function noteFor(value, fallback) {
  if (value && typeof value === 'object' && typeof value.note === 'string') return value.note;
  return fallback;
}

function repoRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const absolute = path.resolve(process.cwd(), value);
  const relative = path.relative(process.cwd(), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function packageVersion() {
  const pkg = readJsonOptional(path.resolve(process.cwd(), 'package.json')).data;
  return typeof pkg?.version === 'string' ? pkg.version : '0.0.0';
}

function parseScorecardName(fileName) {
  const match = fileName.match(/^scorecard-(\d+\.\d+\.\d+)-(.+)\.json$/)
    ?? fileName.match(/^(\d+\.\d+\.\d+)\.json$/);
  if (!match) return null;
  const versionParts = match[1].split('.').map((part) => Number(part));
  if (versionParts.some((part) => !Number.isFinite(part))) return null;
  return { version: match[1], sha: match[2] ?? null, versionParts };
}

function compareScorecardEntries(a, b) {
  for (let idx = 0; idx < 3; idx++) {
    const diff = b.versionParts[idx] - a.versionParts[idx];
    if (diff !== 0) return diff;
  }
  return b.mtimeMs - a.mtimeMs;
}

function listScorecards(targetVersion, targetSha) {
  return PRIOR_SCORECARD_DIRS.flatMap((directory) => {
    let names = [];
    try {
      names = fs.readdirSync(directory);
    } catch {
      return [];
    }
    return names.map((name) => {
      const parsed = parseScorecardName(name);
      if (!parsed) return null;
      const absolute = path.join(directory, name);
      return {
        ...parsed,
        name,
        absolute,
        excluded: parsed.version === targetVersion && parsed.sha === targetSha,
        mtimeMs: fs.statSync(absolute).mtimeMs,
      };
    });
  })
    .filter(Boolean)
    .sort(compareScorecardEntries);
}

function compareVersionParts(a, b) {
  for (let idx = 0; idx < 3; idx++) {
    const diff = a[idx] - b[idx];
    if (diff !== 0) return diff;
  }
  return 0;
}

function priorScorecard(version, sha, targetPath) {
  const entries = listScorecards(version, sha);
  const targetVersionParts = version.split('.').map((part) => Number(part));
  const selected = entries.find((entry) => (
    !entry.excluded && compareVersionParts(entry.versionParts, targetVersionParts) < 0
  ));
  if (selected) {
    return { card: readJsonOptional(selected.absolute).data, source: selected.name };
  }

  if (fs.existsSync(targetPath)) {
    return { card: readJsonOptional(targetPath).data, source: 'same-build rerun' };
  }

  return { card: null, source: null };
}

function priorValue(prior, track, metric) {
  if (prior?.[track]?.status === 'invalid' || prior?.tracks?.[track]?.status === 'invalid') {
    return null;
  }
  return numberOrNull(prior?.tracks?.[track]?.metrics?.[metric]?.value);
}

function classifyDelta(value, prior, direction, threshold, informational = false) {
  if (informational) return { delta: 'informational', deltaValue: null };
  if (typeof prior !== 'number') return { delta: 'baseline', deltaValue: null };
  if (typeof value !== 'number') return { delta: 'missing', deltaValue: null };

  const deltaValue = value - prior;
  if (Math.abs(deltaValue) <= threshold) {
    return { delta: 'unchanged', deltaValue };
  }
  if (direction === 'lower-better') {
    return { delta: deltaValue > 0 ? 'regressed' : 'improved', deltaValue };
  }
  return { delta: deltaValue < 0 ? 'regressed' : 'improved', deltaValue };
}

function metricEntry({ value, note, direction, threshold, prior, informational = false }) {
  const comparison = classifyDelta(value, prior, direction, threshold, informational);
  return {
    value,
    priorValue: typeof prior === 'number' ? prior : null,
    direction,
    threshold,
    ...comparison,
    ...(note ? { note } : {}),
  };
}

function buildSpeedTrack(speed, prior) {
  const metrics = speed?.metrics ?? {};
  const names = [
    ['time_to_splash_ms', 'lower-better', 25],
    ['time_to_reveal_ms', 'lower-better', 100],
    ['boot_api_request_count', 'lower-better', 1],
    ['max_client_queue_stall_ms', 'lower-better', 25],
    ['panel_branches_ms', 'lower-better', 25],
    ['runtime_inventory_ms', 'lower-better', 25],
    ['dashboard_cold_ttfb_ms', 'lower-better', 25],
    ['dashboard_warm_ttfb_ms', 'lower-better', 25],
    ['bootstrap_warm_total_ms', 'lower-better', 25],
    ['cli_status_median_ms', 'lower-better', 25],
    ['mcp_client_minus_server_p50_ms', 'lower-better', 25],
  ];
  const result = {};
  for (const [name, direction, threshold] of names) {
    const raw = metrics[name];
    result[name] = metricEntry({
      value: numberOrNull(raw),
      note: noteFor(raw, speed ? null : 'speed.json missing'),
      direction,
      threshold,
      prior: priorValue(prior, 'speed', name),
    });
  }
  const socketRaw = metrics.socket_avg_conns;
  result.socket_avg_conns = metricEntry({
    value: numberOrNull(socketRaw),
    note: noteFor(socketRaw, speed ? null : 'speed.json missing'),
    direction: 'informational',
    threshold: null,
    prior: priorValue(prior, 'speed', 'socket_avg_conns'),
    informational: true,
  });
  return {
    automatable: true,
    status: speed ? 'ok' : 'not run',
    metrics: result,
  };
}

function memoryCategoryMetricName(category) {
  return `${category}_full_accuracy`;
}

function buildMemoryTrack(memory, prior) {
  const result = {};
  const overall = memory?.summary?.overall ?? {};
  result.overall_full_accuracy = metricEntry({
    value: numberOrNull(overall.full),
    note: memory ? null : 'memory.json missing',
    direction: 'higher-better',
    threshold: 0.05,
    prior: priorValue(prior, 'memory', 'overall_full_accuracy'),
  });
  result.delta_full_vs_strongGrep = metricEntry({
    value: numberOrNull(overall.delta_full_vs_strongGrep),
    note: memory ? null : 'memory.json missing',
    direction: 'higher-better',
    threshold: 0.05,
    prior: priorValue(prior, 'memory', 'delta_full_vs_strongGrep'),
  });

  for (const category of CATEGORIES) {
    const raw = memory?.summary?.perCategory?.[category]?.full_accuracy;
    const name = memoryCategoryMetricName(category);
    result[name] = metricEntry({
      value: numberOrNull(raw),
      note: memory ? null : 'memory.json missing',
      direction: 'higher-better',
      threshold: 0.05,
      prior: priorValue(prior, 'memory', name),
    });
  }

  return {
    automatable: true,
    status: memory ? 'ok' : 'not run',
    sourceResults: repoRelativePath(memory?.sourceResults),
    metrics: result,
  };
}

function buildGovernanceTrack(governance, prior) {
  if (!governance) return { automatable: true, status: 'automated — not run this release' };
  const catchSummary = governance.summary?.catch;
  const cleanSummary = governance.summary?.cleanControls;
  const caught = numberOrNull(catchSummary?.caught);
  const plantedTotal = numberOrNull(catchSummary?.total);
  const cleanBlocked = numberOrNull(cleanSummary?.blocked);
  const cleanWithFindings = numberOrNull(cleanSummary?.withFindings);
  const cleanTotal = numberOrNull(cleanSummary?.total);
  const validCounts = [caught, plantedTotal, cleanBlocked, cleanWithFindings, cleanTotal]
    .every((value) => Number.isInteger(value) && value >= 0)
    && plantedTotal > 0
    && cleanTotal > 0
    && caught <= plantedTotal
    && cleanBlocked <= cleanTotal
    && cleanWithFindings <= cleanTotal;
  if (!validCounts) {
    return {
      automatable: true,
      status: 'invalid governance result — numerator and denominator counts are required',
    };
  }
  const catchRate = caught / plantedTotal;
  const cleanBlockRate = cleanBlocked / cleanTotal;
  const cleanFindingRate = cleanWithFindings / cleanTotal;
  const priorCleanFindingRate = priorValue(prior, 'governance', 'clean_diffs_with_any_finding')
    ?? priorValue(prior, 'governance', 'false_positive_rate')
    ?? priorValue(prior, 'governance', 'fp_rate');
  const inconclusiveSummary = governance.summary?.inconclusive;
  const inconclusiveTotal = numberOrNull(
    typeof inconclusiveSummary === 'object' && inconclusiveSummary !== null
      ? inconclusiveSummary.total
      : inconclusiveSummary,
  ) ?? 0;
  const reviewerBackendCount = Array.isArray(governance.reviewerBackends)
    ? new Set(governance.reviewerBackends).size
    : numberOrNull(governance.lastRun?.reviewerBackendCount);
  return {
    automatable: true,
    status: inconclusiveTotal > 0 ? 'completed with inconclusive reviews' : 'ok',
    scopeStatement: governance.scopeStatement ?? null,
    lastRun: {
      generatedAt: governance.generatedAt ?? governance.lastRun?.date ?? null,
      reviewerBackendCount,
      fixtureCount: governance.fixtureCount ?? governance.lastRun?.nDiffs ?? null,
      inconclusive: typeof inconclusiveSummary === 'object' && inconclusiveSummary !== null
        ? inconclusiveSummary
        : { total: inconclusiveTotal, planted: null, clean: null },
      blindExecution: governance.blindExecution ? {
        shuffled: governance.blindExecution.shuffled === true,
        groundTruthWithheldFromReviewer: governance.blindExecution.groundTruthWithheldFromReviewer === true,
        isolatedRepositoryPerInput: governance.blindExecution.isolatedRepositoryPerInput === true,
      } : null,
    },
    metrics: {
      catch_rate: {
        ...metricEntry({
          value: numberOrNull(catchRate),
          direction: 'higher-better',
          threshold: 0.05,
          prior: priorValue(prior, 'governance', 'catch_rate'),
        }),
        numerator: caught,
        denominator: plantedTotal,
      },
      clean_diffs_blocked: {
        ...metricEntry({
          value: numberOrNull(cleanBlockRate),
          direction: 'lower-better',
          threshold: 0.05,
          prior: priorValue(prior, 'governance', 'clean_diffs_blocked'),
        }),
        numerator: cleanBlocked,
        denominator: cleanTotal,
      },
      clean_diffs_with_any_finding: {
        ...metricEntry({
          value: numberOrNull(cleanFindingRate),
          direction: 'lower-better',
          threshold: 0.05,
          prior: priorCleanFindingRate,
        }),
        numerator: cleanWithFindings,
        denominator: cleanTotal,
      },
    },
  };
}

function buildCodingTrack(coding, prior) {
  if (!coding) return { automatable: false, status: OPERATOR_TRIGGERED_NOT_RUN };
  if (coding.schema === 'o8/coding-benchmark/v2') {
    const runtimeSummaries = Object.values(coding.paired ?? {});
    const pairedContests = runtimeSummaries.reduce((sum, entry) => sum + (numberOrNull(entry?.tasks) ?? 0), 0);
    const decisiveContractWins = runtimeSummaries.reduce(
      (sum, entry) => sum + (numberOrNull(entry?.decisiveContractWins) ?? 0),
      0,
    );
    const contractExcellentOutputs = Object.entries(coding.excellentOutputs ?? {})
      .filter(([condition]) => condition.endsWith('-contract'))
      .reduce((sum, [, value]) => sum + (numberOrNull(value) ?? 0), 0);
    const contractOutputs = (numberOrNull(coding.tasksScored) ?? 0) * runtimeSummaries.length;
    return {
      automatable: false,
      status: coding.tasksScored > 0 ? 'ok' : 'incomplete',
      lastRun: {
        generatedAt: coding.generatedAt ?? null,
        protocol: coding.protocol ?? null,
        productBarCleared: coding.contractImprovesQuality === true,
      },
      metrics: {
        decisive_contract_wins: {
          ...metricEntry({
            value: decisiveContractWins,
            direction: 'higher-better',
            threshold: 0,
            prior: priorValue(prior, 'coding', 'decisive_contract_wins'),
          }),
          numerator: decisiveContractWins,
          denominator: pairedContests,
        },
        contract_excellent_outputs: {
          ...metricEntry({
            value: contractExcellentOutputs,
            direction: 'higher-better',
            threshold: 0,
            prior: priorValue(prior, 'coding', 'contract_excellent_outputs'),
          }),
          numerator: contractExcellentOutputs,
          denominator: contractOutputs,
        },
      },
    };
  }
  const passRate = coding.lastRun?.passRate ?? coding.passRate ?? coding.metrics?.pass_rate;
  return {
    automatable: false,
    status: 'ok',
    lastRun: coding.lastRun ?? null,
    metrics: {
      pass_rate: metricEntry({
        value: numberOrNull(passRate),
        direction: 'higher-better',
        threshold: 0.05,
        prior: priorValue(prior, 'coding', 'pass_rate'),
      }),
    },
  };
}

function formatValue(value) {
  return typeof value === 'number' ? String(Number(value.toFixed(3))) : 'null';
}

function renderMetricRows(trackName, track) {
  if (!track.metrics) return `## ${trackName}\n_${track.status}_\n`;
  const rows = ['| Metric | Value | N | Prior | Direction | Delta |', '| --- | ---: | ---: | ---: | --- | --- |'];
  for (const [name, metric] of Object.entries(track.metrics)) {
    const sample = typeof metric.numerator === 'number' && typeof metric.denominator === 'number'
      ? `${metric.numerator}/${metric.denominator}`
      : '-';
    rows.push(`| ${name} | ${formatValue(metric.value)} | ${sample} | ${formatValue(metric.priorValue)} | ${metric.direction} | ${metric.delta} |`);
  }
  return `## ${trackName}\n${rows.join('\n')}\n`;
}

function renderMarkdown(card, priorSource) {
  const governanceScope = card.tracks.governance.scopeStatement;
  const target = card.target;
  const lines = [
    '# o8 Benchmark Scorecard',
    '',
    `Version: ${card.version}`,
    `Git SHA: ${card.gitSha}`,
    `Timestamp: ${card.timestamp}`,
    `Node: ${card.node}`,
    `Prior: ${priorSource ?? 'none'}`,
    `Target version: ${target?.appVersion ?? 'unavailable'}`,
    `Target Git SHA: ${target?.buildGitSha ?? 'unavailable'}`,
    `Target build mode: ${target?.buildMode ?? 'unavailable'}`,
    `Target platform: ${target?.platform ?? 'unavailable'}`,
    ...(target?.unavailableReason ? [`Target identity note: ${target.unavailableReason}`] : []),
    ...(governanceScope ? [`Governance scope: ${governanceScope}`] : []),
    '',
    renderMetricRows('Speed', card.tracks.speed),
    renderMetricRows('Memory', card.tracks.memory),
    renderMetricRows('Governance', card.tracks.governance),
    renderMetricRows('Coding', card.tracks.coding),
  ];
  return lines.join('\n');
}

function printSummary(card) {
  console.log('[bench-score] track\tmetric\tvalue\tn\tdelta');
  for (const [trackName, track] of Object.entries(card.tracks)) {
    if (!track.metrics) {
      console.log(`[bench-score] ${trackName}\t-\t-\t-\t${track.status}`);
      continue;
    }
    for (const [metricName, metric] of Object.entries(track.metrics)) {
      const sample = typeof metric.numerator === 'number' && typeof metric.denominator === 'number'
        ? `${metric.numerator}/${metric.denominator}`
        : '-';
      console.log(`[bench-score] ${trackName}\t${metricName}\t${formatValue(metric.value)}\t${sample}\t${metric.delta}`);
    }
  }
}

function main() {
  fs.mkdirSync(SCORECARD_DIR, { recursive: true });
  const version = packageVersion();
  const sha = gitSha();
  const jsonPath = path.join(SCORECARD_DIR, `scorecard-${version}-${sha}.json`);
  const mdPath = path.join(SCORECARD_DIR, `scorecard-${version}-${sha}.md`);
  const latestPath = path.join(SCORECARD_DIR, 'latest.md');

  const { card: prior, source: priorSource } = priorScorecard(version, sha, jsonPath);
  const speed = readJsonOptional(path.join(LATEST_DIR, 'speed.json')).data;
  const memory = readJsonOptional(path.join(LATEST_DIR, 'memory.json')).data;
  const governance = readJsonOptional(path.join(LATEST_DIR, 'governance.json')).data;
  const coding = readJsonOptional(path.join(LATEST_DIR, 'coding.json')).data;

  const card = {
    version,
    gitSha: sha,
    target: speed?.target ?? null,
    timestamp: new Date().toISOString(),
    node: process.version,
    comparedTo: priorSource,
    tracks: {
      speed: buildSpeedTrack(speed, prior),
      memory: buildMemoryTrack(memory, prior),
      governance: buildGovernanceTrack(governance, prior),
      coding: buildCodingTrack(coding, prior),
    },
  };

  const markdown = renderMarkdown(card, priorSource);
  fs.writeFileSync(jsonPath, JSON.stringify(card, null, 2));
  fs.writeFileSync(mdPath, markdown);
  fs.writeFileSync(latestPath, markdown);
  printSummary(card);
  console.log(`[bench-score] wrote ${jsonPath}`);
}

try {
  main();
} catch (err) {
  console.error(`[bench-score] failed without throwing: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 0;
}
