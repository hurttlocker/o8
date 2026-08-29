#!/usr/bin/env node

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const session = String(option('session', 'session'));
const durationMs = Math.max(1000, Number(option('duration-ms', 30000)) || 30000);
const intervalMs = Math.max(40, Number(option('interval-ms', 100)) || 100);
const totalLines = Math.ceil(durationMs / intervalMs);
const MAX_LINE_COLUMNS = 72;
let sequence = 0;

function writeLine(value, callback) {
  if (value.length > MAX_LINE_COLUMNS) {
    throw new Error(`rapid generator line exceeds ${MAX_LINE_COLUMNS} columns: ${value.length}`);
  }
  process.stdout.write(`${value}\r\n`, callback);
}

process.stdout.write('\r\n');
writeLine(`O8_RAPID_READY_${session}`);
const timer = setInterval(() => {
  writeLine(`O8_RAPID_${session}_${String(sequence).padStart(5, '0')}`);
  sequence += 1;
  if (sequence < totalLines) return;
  clearInterval(timer);
  writeLine(`O8_RAPID_DONE_${session}_${totalLines}`, () => process.exit(0));
}, intervalMs);

timer.unref?.();
