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
const startPaused = process.argv.includes('--start-paused');
const totalTicks = Math.max(1, Math.ceil(durationMs / chunkMs));
const bytesPerTick = Math.max(32, Math.floor(bytesPerSecond * chunkMs / 1000));
const altEnterTick = Math.floor(totalTicks * 0.25);
const altExitTick = Math.floor(totalTicks * 0.8);
const MAX_LINE_COLUMNS = 72;

let state = seed >>> 0;
let tick = 0;
let paused = startPaused;
let alternateScreen = false;
let inputBuffer = '';
let inputNoiseCount = 0;

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

function boundedLine(value) {
  if (value.length > MAX_LINE_COLUMNS) {
    throw new Error(`generator line exceeds ${MAX_LINE_COLUMNS} columns: ${value.length}`);
  }
  return value;
}

function writeLine(value) {
  boundedLine(value);
  process.stdout.write(`\r\n${value}\r\n`);
}

function stripInputNoise(value) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, () => {
      inputNoiseCount += 1;
      return '';
    })
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, () => {
      inputNoiseCount += 1;
      return '';
    })
    .replace(/\x1b[@-Z\\-_]/g, () => {
      inputNoiseCount += 1;
      return '';
    })
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, () => {
      inputNoiseCount += 1;
      return '';
    });
}

function fixedChunk(index) {
  const color = `\x1b[${31 + (index % 6)}m`;
  const reset = '\x1b[0m';
  const sessionToken = session.slice(-8);
  const linePrefix = (lineIndex) => lineIndex === 0
    ? `T${String(index).padStart(5, '0')} ${sessionToken} ${seed} `
    : `D${String(index).padStart(5, '0')}.${String(lineIndex).padStart(3, '0')} `;
  let lineCount = 1;
  let visibleBudget = 0;
  for (; lineCount <= bytesPerTick; lineCount += 1) {
    const controlBytes = lineCount * Buffer.byteLength(`\r\x1b[2K${color}${reset}\r\n`);
    visibleBudget = bytesPerTick - controlBytes;
    const prefixBytes = Array.from({ length: lineCount }, (_, lineIndex) => linePrefix(lineIndex).length)
      .reduce((total, length) => total + length, 0);
    if (visibleBudget >= prefixBytes && visibleBudget <= lineCount * MAX_LINE_COLUMNS) break;
  }
  if (lineCount > bytesPerTick) throw new Error(`cannot split ${bytesPerTick} bytes into bounded lines`);

  const prefixes = Array.from({ length: lineCount }, (_, lineIndex) => linePrefix(lineIndex));
  let payloadBytes = visibleBudget - prefixes.reduce((total, prefix) => total + prefix.length, 0);
  const lines = prefixes.map((prefix) => {
    const length = Math.min(MAX_LINE_COLUMNS - prefix.length, payloadBytes);
    payloadBytes -= length;
    return `${color}${prefix}${randomWord(length)}${reset}`;
  });
  if (payloadBytes !== 0) throw new Error(`failed to allocate ${payloadBytes} generator bytes`);
  return lines.map((line) => `\r\x1b[2K${line}\r\n`).join('');
}

function handleInput(line) {
  const value = line.trim();
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
  process.stdout.write(`\r\n${value.slice(0, MAX_LINE_COLUMNS)}\r\n`);
  setTimeout(() => { paused = false; }, 140).unref();
}

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  if (!/[\r\n]/.test(inputBuffer)) return;
  const lines = stripInputNoise(inputBuffer).split(/\r|\n/);
  inputBuffer = lines.pop() ?? '';
  lines.forEach(handleInput);
});

writeLine(`O8_WORKLOAD_READY_${session}_${seed}`);

const timer = setInterval(() => {
  if (paused) return;
  if (tick === altEnterTick) {
    const marker = boundedLine(`O8_ALT_SCREEN_ENTER_${session}_${seed}`);
    process.stdout.write(`\x1b[?1049h\x1b[2J\x1b[H${marker}\r\n`);
    alternateScreen = true;
  }
  if (tick === altExitTick && alternateScreen) {
    const marker = boundedLine(`O8_ALT_SCREEN_EXIT_${session}_${seed}`);
    process.stdout.write(`\x1b[?1049l\r\n${marker}\r\n`);
    alternateScreen = false;
  }
  process.stdout.write(alternateScreen ? `\x1b[H${fixedChunk(tick)}` : fixedChunk(tick));
  tick += 1;
  if (tick < totalTicks) return;
  clearInterval(timer);
  if (alternateScreen) {
    const marker = boundedLine(`O8_ALT_SCREEN_EXIT_${session}_${seed}`);
    process.stdout.write(`\x1b[?1049l\r\n${marker}\r\n`);
  }
  if (inputNoiseCount > 0) {
    writeLine(`O8_INPUT_NOISE_${inputNoiseCount}`);
  }
  writeLine(`O8_WORKLOAD_DONE_${session}_${seed}`);
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(false);
  }
  setTimeout(() => process.exit(0), 40).unref();
}, chunkMs);

timer.unref?.();
process.stdin.on('end', () => process.exit(0));
