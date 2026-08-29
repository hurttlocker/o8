#!/usr/bin/env node

import fs from 'node:fs';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const session = String(option('session', 'session'));
const logPath = String(option('log', ''));
const durationMs = Math.max(1000, Number(option('duration-ms', 30000)) || 30000);
const intervalMs = Math.max(40, Number(option('interval-ms', 100)) || 100);
const totalLines = Math.ceil(durationMs / intervalMs);
const MAX_LINE_COLUMNS = 72;
let sequence = 0;
let stdoutBackpressureCount = 0;
let stdoutDrainCount = 0;
let stdoutErrorCount = 0;

function logEvent(event, details = {}) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify({ event, pid: process.pid, ts: Date.now(), ...details })}\n`);
}

function writeLine(value, callback) {
  if (value.length > MAX_LINE_COLUMNS) {
    throw new Error(`rapid generator line exceeds ${MAX_LINE_COLUMNS} columns: ${value.length}`);
  }
  const accepted = process.stdout.write(`${value}\r\n`, callback);
  if (!accepted) stdoutBackpressureCount += 1;
}

if (logPath) fs.writeFileSync(logPath, '');
logEvent('start', { sequence: 0 });
process.stdout.on('drain', () => {
  stdoutDrainCount += 1;
  logEvent('stdout-drain', { count: stdoutDrainCount, sequence });
});
process.stdout.on('error', (error) => {
  stdoutErrorCount += 1;
  logEvent('stdout-error', { count: stdoutErrorCount, sequence, stack: error.stack ?? String(error) });
});
process.on('exit', (code) => {
  logEvent('exit', {
    code,
    lastSequence: sequence,
    stdoutBackpressureCount,
    stdoutDrainCount,
    stdoutErrorCount,
  });
});
process.on('uncaughtException', (error) => {
  logEvent('uncaughtException', { sequence, stack: error.stack ?? String(error) });
  process.exit(1);
});

process.stdout.write('\r\n');
writeLine(`O8_RAPID_READY_${session}`);
const timer = setInterval(() => {
  writeLine(`O8_RAPID_${session}_${String(sequence).padStart(5, '0')}`);
  sequence += 1;
  if (sequence % 50 === 0) {
    logEvent('sequence', {
      sequence,
      stdoutBackpressureCount,
      stdoutDrainCount,
      stdoutErrorCount,
    });
  }
  if (sequence < totalLines) return;
  clearInterval(timer);
  writeLine(`O8_RAPID_DONE_${session}_${totalLines}`, () => process.exit(0));
}, intervalMs);
