#!/usr/bin/env node
// Fast pre-release gate: typecheck -> lint -> build. Fail-fast on any step.
// Usage: npm run smoke

import { spawn } from 'node:child_process';

const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const CYAN = '\u001b[36m';
const RESET = '\u001b[0m';

const STEPS = [
  { name: 'Typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'Lint', cmd: 'npm', args: ['run', 'lint'] },
  { name: 'Build', cmd: 'npm', args: ['run', 'build'] },
];

function formatDuration(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return `${minutes}m ${rem}s`;
}

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(step.cmd, step.args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, elapsed: Date.now() - started });
    });
    child.on('error', (err) => {
      process.stderr.write(`${RED}${step.name} failed to spawn: ${err.message}${RESET}\n`);
      resolve({ code: 1, elapsed: Date.now() - started });
    });
  });
}

async function main() {
  const total = STEPS.length;
  const overallStart = Date.now();
  for (let i = 0; i < total; i += 1) {
    const step = STEPS[i];
    const header = `${BOLD}${CYAN}[${i + 1}/${total}] ${step.name}${RESET} ${DIM}(${step.cmd} ${step.args.join(' ')})${RESET}`;
    process.stdout.write(`\n${header}\n`);
    const { code, elapsed } = await runStep(step);
    if (code !== 0) {
      process.stdout.write(`\n${RED}${BOLD}FAIL${RESET} ${step.name} exited with code ${code} after ${formatDuration(elapsed)}\n`);
      process.exit(code);
    }
    process.stdout.write(`${GREEN}PASS${RESET} ${step.name} (${formatDuration(elapsed)})\n`);
  }
  const overall = Date.now() - overallStart;
  process.stdout.write(`\n${GREEN}${BOLD}smoke ok${RESET} ${DIM}(${formatDuration(overall)} total)${RESET}\n`);
}

main().catch((err) => {
  process.stderr.write(`${RED}smoke crashed: ${err?.stack ?? err}${RESET}\n`);
  process.exit(1);
});
