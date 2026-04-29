#!/usr/bin/env node
/**
 * #798 — CLI helper that POSTs to /api/panel/loop-state.
 *
 * Wraps the gated panel endpoint so loop tooling (e.g. CronCreate output)
 * can pipe directly into a state write without re-implementing token /
 * port resolution.
 *
 * Usage:
 *   node scripts/loop-state-write.mjs arm \
 *     --jobId=c9ffe2f4 \
 *     --cron='*\/20 * * * *' \
 *     --prompt='check the deploy queue'
 *
 *   node scripts/loop-state-write.mjs tick --nextFireAt=2026-04-28T12:20:00Z
 *
 *   node scripts/loop-state-write.mjs disarm
 *
 * Resolution order:
 *   - ws-token: $O8_WS_TOKEN env, otherwise ~/.o8/ws-token (with a
 *     ~/.cortex-ide/ws-token legacy fallback).
 *   - port: $O8_API_PORT, $PORT, ~/.o8/api-port, then 3001.
 *
 * Exits 0 on success, 1 on validation/network error. Prints the response
 * payload to stdout on success and the error reason to stderr on failure.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const [, , action, ...rest] = argv;
  const flags = {};
  for (const arg of rest) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      flags[arg.slice(2)] = true;
    } else {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return { action, flags };
}

function dataDirCandidates() {
  const home = homedir();
  // Prefer the new ~/.o8 location, fall back to ~/.cortex-ide for installs
  // that haven't run the migration yet.
  return [
    process.env.O8_DATA_DIR,
    process.env.CORTEX_IDE_DATA_DIR,
    join(home, '.o8'),
    join(home, '.cortex-ide'),
  ].filter(Boolean);
}

function readFirstExisting(filename) {
  for (const dir of dataDirCandidates()) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, 'utf8').trim();
        if (raw) return raw;
      } catch {
        // try next candidate
      }
    }
  }
  return null;
}

function resolveWsToken() {
  if (process.env.O8_WS_TOKEN) return process.env.O8_WS_TOKEN.trim();
  return readFirstExisting('ws-token');
}

function resolveApiPort() {
  const fromEnv = process.env.O8_API_PORT
    || process.env.PORT
    || process.env.CORTEX_IDE_PORT;
  if (fromEnv) {
    const n = parseInt(fromEnv, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  const fromFile = readFirstExisting('api-port');
  if (fromFile) {
    const n = parseInt(fromFile, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return 3001;
}

function buildPayload(action, flags) {
  if (action === 'arm') {
    const jobId = flags.jobId || flags['job-id'];
    const cronExpression = flags.cron || flags.cronExpression || flags['cron-expression'];
    const prompt = flags.prompt;
    if (!jobId) throw new Error('--jobId is required for arm');
    if (!cronExpression) throw new Error('--cron is required for arm');
    if (!prompt) throw new Error('--prompt is required for arm');
    const body = { action: 'arm', jobId, cronExpression, prompt };
    const nextFireAt = flags.nextFireAt || flags['next-fire-at'];
    if (nextFireAt) body.nextFireAt = nextFireAt;
    return body;
  }
  if (action === 'tick') {
    const body = { action: 'tick' };
    const nextFireAt = flags.nextFireAt || flags['next-fire-at'];
    if (nextFireAt) body.nextFireAt = nextFireAt;
    return body;
  }
  if (action === 'disarm') {
    return { action: 'disarm' };
  }
  throw new Error(`Unknown action: ${action || '<none>'}. Expected arm, tick, or disarm.`);
}

async function main() {
  const { action, flags } = parseArgs(process.argv);
  if (!action) {
    process.stderr.write('Usage: loop-state-write.mjs <arm|tick|disarm> [--flag=value ...]\n');
    process.exit(1);
  }

  let payload;
  try {
    payload = buildPayload(action, flags);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  const port = resolveApiPort();
  const token = resolveWsToken();
  const url = `http://127.0.0.1:${port}/api/panel/loop-state`;

  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    process.stderr.write(`Request to ${url} failed: ${err.message}\n`);
    process.exit(1);
  }

  const text = await res.text();
  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status}: ${text}\n`);
    process.exit(1);
  }

  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err?.message || err}\n`);
  process.exit(1);
});
