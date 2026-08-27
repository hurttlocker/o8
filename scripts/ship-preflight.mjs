#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performShipPreflight, runQuickBenchmarkPreflight } from './lib/ship-preflight.mjs';
import { intakeReconciliationDiagnostic } from './lib/intake-reconciliation.mjs';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const receipt = performShipPreflight({ root, version: packageJson.version });
const intake = receipt.intakeReconciliation;
if (intake.status === 'configured') {
  console.log(`[release] ${intakeReconciliationDiagnostic(intake)}`);
} else if (intake.status === 'disabled') {
  console.log(`[release] ${intakeReconciliationDiagnostic(intake)}; ship remains independent`);
} else {
  console.warn(`[release] intake warning: ${intakeReconciliationDiagnostic(intake)}; ship remains independent`);
}
const benchmark = runQuickBenchmarkPreflight({ root });
if (benchmark.status === 'regressed') {
  console.warn(`[release] benchmark warning: ${benchmark.regressions.map((entry) => entry.name).join(', ')} regressed; ship remains unblocked`);
} else if (benchmark.status === 'incomplete') {
  console.warn(`[release] benchmark warning: ${benchmark.missing.join(', ')} unavailable; ship remains unblocked`);
} else if (benchmark.status === 'unavailable') {
  console.warn(`[release] benchmark warning: speed check unavailable (${benchmark.message}); ship remains unblocked`);
} else {
  console.log(`[release] speed benchmark passed in ${benchmark.durationMs}ms`);
}
console.log(`[release] preflight passed for ${receipt.tag} at ${receipt.head.slice(0, 12)} (${receipt.availableGiB.toFixed(1)} GiB free)`);
