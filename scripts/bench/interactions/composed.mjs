// Composition with the terminal-workload harness.
//
// #1697 asks for terminal keystroke-to-paint at 1, 4, and 12 live surfaces and
// for tab/pane switching under load. That lane already exists, is operator-
// locked, and is far stronger than anything this harness would re-derive from a
// chat composer. So the interaction receipt COMPOSES it: it reads the committed
// terminal-workload receipt, re-runs its own locked budget check, and reports
// the verdict with full provenance instead of duplicating a weaker metric.
import fs from 'node:fs';
import path from 'node:path';
import { checkTerminalWorkloadBudgets, LOCKED_TERMINAL_WORKLOAD_BUDGETS } from '../terminal-workload/budgets.mjs';

export const TERMINAL_WORKLOAD_RECEIPT = 'tests/bench/results/terminal-workload-phase2.json';

function distributionOrNull(summary, key) {
  const value = summary?.[key];
  if (!value || typeof value !== 'object') return null;
  return { samples: value.samples ?? null, p50: value.p50 ?? null, p95: value.p95 ?? null };
}

export function summarizeTerminalWorkload(receipt, { measuredTarget = null, receiptPath = TERMINAL_WORKLOAD_RECEIPT } = {}) {
  if (!receipt) {
    return {
      source: receiptPath,
      status: 'unavailable',
      unavailableReason: `${receiptPath} is missing or unreadable; run npm run bench:terminal to produce it`,
      coverage: null,
    };
  }
  if (receipt.schema !== 'o8/terminal-workload/v1') {
    return {
      source: receiptPath,
      status: 'unavailable',
      unavailableReason: `unexpected schema ${receipt.schema ?? 'missing'} in ${receiptPath}`,
      coverage: null,
    };
  }
  const failures = checkTerminalWorkloadBudgets(receipt);
  const rapidSwitchSamples = (receipt.samples ?? []).filter((sample) => sample.sessionCount === 12);
  const coverage = {};
  for (const sessionCount of ['1', '4', '12']) {
    const summary = receipt.summary?.[sessionCount];
    coverage[sessionCount] = summary
      ? {
        sampleCount: summary.sampleCount ?? null,
        keystrokeToPaintMs: distributionOrNull(summary, 'keystrokeToPaintMs'),
        revealMs: distributionOrNull(summary, 'revealMs'),
        firstCorrectFrameMs: distributionOrNull(summary, 'firstCorrectFrameMs'),
        longTaskMsPerMinute: distributionOrNull(summary, 'longTaskMsPerMinute'),
      }
      : { unavailableReason: `no N=${sessionCount} summary in the receipt` };
  }
  // Composition is current-build proof only when both sides expose the same
  // full Git SHA and the terminal receipt came from a clean tree. Older shipped
  // builds do not expose that SHA, so their composed terminal data is labelled
  // historical instead of being silently promoted to proof about this target.
  const measuredGitSha = measuredTarget?.buildGitSha ?? null;
  const sameBuild = Boolean(
    measuredGitSha
    && receipt.commit
    && receipt.dirty === false
    && measuredGitSha.toLowerCase() === receipt.commit.toLowerCase(),
  );
  const provenance = sameBuild ? 'current-build' : 'historical';
  const provenanceNote = sameBuild
    ? `terminal workload and measured target share commit ${receipt.commit.slice(0, 9)}; current-build proof`
    : receipt.commit
      ? `historical terminal workload measured on commit ${receipt.commit.slice(0, 9)}${receipt.dirty ? ' (dirty tree)' : ''} at ${receipt.generatedAt}; current target Git SHA ${measuredGitSha ?? 'unavailable'}`
      : `historical terminal workload provenance is incomplete: ${receiptPath} records no commit`;
  return {
    source: receiptPath,
    status: sameBuild ? (failures.length > 0 ? 'fail' : 'pass') : 'historical',
    budgetStatus: failures.length === 0 ? 'pass' : 'fail',
    provenance,
    currentBuildProof: sameBuild,
    generatedAt: receipt.generatedAt ?? null,
    commit: receipt.commit ?? null,
    dirty: receipt.dirty ?? null,
    buildMode: receipt.buildMode ?? null,
    hardware: receipt.hardware ?? null,
    provenanceNote,
    budgetFailures: failures,
    lockedBudgets: {
      keystrokeToPaintMsP50Max: LOCKED_TERMINAL_WORKLOAD_BUDGETS.keystrokeToPaintMsP50Max,
      keystrokeToPaintMsP95Max: LOCKED_TERMINAL_WORKLOAD_BUDGETS.keystrokeToPaintMsP95Max,
      revealMsP95Max: LOCKED_TERMINAL_WORKLOAD_BUDGETS.revealMsP95Max,
    },
    rapidSwitch: {
      samples: rapidSwitchSamples.length,
      allPassed: rapidSwitchSamples.length > 0 && rapidSwitchSamples.every((sample) => sample.rapidSwitch?.passed === true),
    },
    coverage,
  };
}

export function readTerminalWorkloadComposition(root, { measuredTarget = null, receiptPath = TERMINAL_WORKLOAD_RECEIPT } = {}) {
  const absolute = path.resolve(root, receiptPath);
  let receipt = null;
  try {
    receipt = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    receipt = null;
  }
  return summarizeTerminalWorkload(receipt, { measuredTarget, receiptPath });
}
