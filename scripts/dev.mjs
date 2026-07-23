#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const stateDir = join(
  process.env.O8_DATA_DIR
    || process.env.CORTEX_IDE_DATA_DIR
    || join(homedir(), '.o8'),
  'dev',
);
const pidFile = join(stateDir, 'pids.json');
const env = {
  ...process.env,
  PORT: process.env.PORT || '47120',
  O8_API_PORT: process.env.O8_API_PORT || process.env.PORT || '47120',
  WS_PORT: process.env.WS_PORT || '47125',
  O8_WS_PORT: process.env.O8_WS_PORT || process.env.WS_PORT || '47125',
};

function readEntries() {
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(entries) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pidFile, JSON.stringify(entries, null, 2));
}

function remember(pid, label) {
  const entries = readEntries().filter((entry) => entry.pid !== pid);
  entries.push({ pid, label, cwd: root, startedAt: Date.now() });
  writeEntries(entries);
}

function forget(pid) {
  const entries = readEntries().filter((entry) => entry.pid !== pid);
  if (entries.length) writeEntries(entries);
  else if (existsSync(pidFile)) rmSync(pidFile);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanup() {
  const entries = readEntries();
  const ours = entries.filter((entry) => entry && entry.cwd === root && Number.isInteger(entry.pid));
  for (const entry of ours) {
    if (!pidAlive(entry.pid)) continue;
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  for (const entry of ours) {
    if (!pidAlive(entry.pid)) continue;
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch {}
  }
  const survivors = entries.filter((entry) => entry && entry.cwd !== root && pidAlive(entry.pid));
  if (survivors.length) writeEntries(survivors);
  else if (existsSync(pidFile)) rmSync(pidFile);
}

function run(label, command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
  remember(child.pid, label);

  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {}
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    forget(child.pid);
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

async function all() {
  await cleanup();
  const next = spawn(process.execPath, ['scripts/dev.mjs', 'next'], { cwd: root, env, stdio: 'inherit' });
  const ws = spawn(process.execPath, ['scripts/dev.mjs', 'ws'], { cwd: root, env, stdio: 'inherit' });
  remember(next.pid, 'dev:next-wrapper');
  remember(ws.pid, 'dev:ws-wrapper');

  const stop = (signal) => {
    for (const child of [next, ws]) {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  let exiting = false;
  for (const child of [next, ws]) {
    child.on('exit', (code) => {
      forget(child.pid);
      if (exiting) return;
      exiting = true;
      stop('SIGTERM');
      process.exit(code ?? 0);
    });
  }
}

const mode = process.argv[2] || 'all';
if (mode === 'cleanup') await cleanup();
else if (mode === 'next') run('dev:next', 'next', ['dev', '-p', env.PORT]);
else if (mode === 'ws') {
  env.NODE_OPTIONS = [env.NODE_OPTIONS, '--import=./scripts/register-server-only-stub.mjs']
    .filter(Boolean)
    .join(' ');
  run('dev:ws', 'tsx', ['src/ws-server.ts']);
} else if (mode === 'all') await all();
else {
  console.error(`unknown dev mode: ${mode}`);
  process.exit(1);
}
