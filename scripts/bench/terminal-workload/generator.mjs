#!/usr/bin/env node

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const session = String(option('session', 'session'));
const bytesPerSecond = Math.max(1024, Number(option('bytes-per-second', 81920)) || 81920);
const durationMs = Math.max(1000, Number(option('duration-ms', 10000)) || 10000);
const chunkMs = Math.max(8, Number(option('chunk-ms', 32)) || 32);
const seed = Number(option('seed', 1721)) || 1721;
const totalTicks = Math.max(1, Math.ceil(durationMs / chunkMs));
const bytesPerTick = Math.max(32, Math.floor(bytesPerSecond * chunkMs / 1000));
const altEnterTick = Math.floor(totalTicks * 0.25);
const altExitTick = Math.floor(totalTicks * 0.8);

let state = seed >>> 0;
let tick = 0;
let paused = false;
let alternateScreen = false;
let inputBuffer = '';

function randomWord(length) {
  let output = '';
  while (output.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output += (state >>> 0).toString(36);
  }
  return output.slice(0, length);
}

function writeLine(value) {
  process.stdout.write(`\r\n${value}\r\n`);
}

function fixedChunk(index) {
  const prefix = `\x1b[${31 + (index % 6)}m${session} tick=${String(index).padStart(5, '0')} seed=${seed} `;
  const suffix = '\x1b[0m';
  const fillLength = Math.max(0, bytesPerTick - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
  return `${prefix}${randomWord(fillLength)}${suffix}`;
}

function handleInput(line) {
  const value = line.replace(/\n/g, '').trim();
  if (!value) return;
  if (value.startsWith('O8_BENCH_REVEAL:')) {
    paused = true;
    writeLine(value.slice('O8_BENCH_REVEAL:'.length));
    return;
  }
  if (value === 'O8_BENCH_RESUME') {
    paused = false;
    return;
  }
  paused = true;
  writeLine(value);
  setTimeout(() => { paused = false; }, 140).unref();
}

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  while (inputBuffer.includes('\r')) {
    const separator = inputBuffer.indexOf('\r');
    const line = inputBuffer.slice(0, separator);
    inputBuffer = inputBuffer.slice(separator + 1);
    handleInput(line);
  }
});

writeLine(`O8_WORKLOAD_READY_${session}_${seed}`);

const timer = setInterval(() => {
  if (paused) return;
  if (tick === altEnterTick) {
    process.stdout.write(`\x1b[?1049h\x1b[2J\x1b[HO8_ALT_SCREEN_ENTER_${session}_${seed}\r\n`);
    alternateScreen = true;
  }
  if (tick === altExitTick && alternateScreen) {
    process.stdout.write(`\x1b[?1049l\r\nO8_ALT_SCREEN_EXIT_${session}_${seed}\r\n`);
    alternateScreen = false;
  }
  process.stdout.write(alternateScreen ? `\x1b[H${fixedChunk(tick)}` : `\r\x1b[2K${fixedChunk(tick)}`);
  tick += 1;
  if (tick < totalTicks) return;
  clearInterval(timer);
  if (alternateScreen) process.stdout.write(`\x1b[?1049l\r\nO8_ALT_SCREEN_EXIT_${session}_${seed}\r\n`);
  writeLine(`O8_WORKLOAD_DONE_${session}_${seed}`);
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(false);
  }
  setTimeout(() => process.exit(0), 40).unref();
}, chunkMs);

timer.unref?.();
process.stdin.on('end', () => process.exit(0));
