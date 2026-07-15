#!/usr/bin/env node

import assert from 'node:assert/strict';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const marker = '[symon-localization]';
const defaultLog = join(homedir(), 'Library/Logs/ai.o8.desktop/o8.log');

function parseArgs(argv) {
  const options = { expect: 'exact', timeout: 120, log: defaultLog, fromStart: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--expect') options.expect = argv[++index];
    else if (arg === '--timeout') options.timeout = Number(argv[++index]);
    else if (arg === '--log') options.log = argv[++index];
    else if (arg === '--from-start') options.fromStart = true;
    else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['exact', 'fallback', 'any'].includes(options.expect)) {
    throw new Error('--expect must be exact, fallback, or any');
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  return options;
}

function verdict(stages, expected) {
  const { capture, model, overlay } = stages;
  if (capture?.status === 'screen_capture_failed') {
    return { state: 'fail', reason: 'Screen capture failed. Grant Screen Recording and relaunch o8.' };
  }
  if (expected === 'exact' && capture && capture.status !== 'ready') {
    return { state: 'fail', reason: `AX catalog was unavailable (${capture.status}). Check Accessibility permission.` };
  }
  if (expected === 'exact' && capture?.catalogCount === 0) {
    return { state: 'fail', reason: 'The AX catalog was empty. Focus a native control and check Accessibility permission.' };
  }
  if (expected === 'exact' && model && model.exactTagCount === 0) {
    return { state: 'fail', reason: 'The model emitted no exact element tag; inspect prompt/model selection.' };
  }
  if (overlay?.stale > 0) {
    return { state: 'fail', reason: `The overlay rejected ${overlay.stale} stale catalog target(s).` };
  }
  if (!capture || !model || !overlay) return { state: 'waiting' };

  const hasOutput = overlay.outputCount > 0;
  if (expected === 'exact') {
    const pass = capture.catalogCount > 0 && model.exactTagCount > 0 && overlay.exactResolved > 0 && hasOutput;
    return pass
      ? { state: 'pass', reason: 'AX catalog -> exact model tag -> production overlay resolver passed.' }
      : { state: 'fail', reason: 'The exact localization stages completed without an exact overlay target.' };
  }
  if (expected === 'fallback') {
    const pass = model.pixelTagCount > 0 && overlay.axSnapped + overlay.directPixel > 0 && hasOutput;
    return pass
      ? { state: 'pass', reason: 'Pixel fallback -> role-filtered overlay resolver passed.' }
      : { state: 'fail', reason: 'The fallback stages completed without a usable pixel target.' };
  }
  return hasOutput
    ? { state: 'pass', reason: 'Capture -> model -> overlay completed with a rendered target.' }
    : { state: 'fail', reason: 'All stages completed, but the overlay produced no target.' };
}

function timeoutReason(stages) {
  if (!stages.capture) return 'No capture trace: this o8 process may not contain the branch build, or the screen-agent gesture did not fire.';
  if (!stages.model) return 'Capture completed, but no model trace arrived: the agent turn did not finish.';
  if (!stages.overlay) return 'Model completed, but no overlay trace arrived: it emitted no target tags or the overlay path was not reached.';
  return 'The trace completed without satisfying the selected expectation.';
}

function parseEvent(line) {
  const markerIndex = line.indexOf(marker);
  if (markerIndex < 0) return null;
  const jsonIndex = line.indexOf('{', markerIndex + marker.length);
  if (jsonIndex < 0) return null;
  try {
    return JSON.parse(line.slice(jsonIndex));
  } catch {
    return null;
  }
}

function selfTest() {
  const capture = { stage: 'capture', status: 'ready', catalogCount: 4 };
  const exact = {
    capture,
    model: { stage: 'model', exactTagCount: 1, pixelTagCount: 0 },
    overlay: { stage: 'overlay', exactResolved: 1, axSnapped: 0, directPixel: 0, stale: 0, outputCount: 1 },
  };
  const fallback = {
    capture: { ...capture, status: 'no_focused_window', catalogCount: 0 },
    model: { stage: 'model', exactTagCount: 0, pixelTagCount: 1 },
    overlay: { stage: 'overlay', exactResolved: 0, axSnapped: 0, directPixel: 1, stale: 0, outputCount: 1 },
  };
  assert.equal(verdict(exact, 'exact').state, 'pass');
  assert.equal(verdict(fallback, 'fallback').state, 'pass');
  assert.equal(verdict({ capture }, 'exact').state, 'waiting');
  assert.equal(verdict({ capture: { ...capture, catalogCount: 0 } }, 'exact').state, 'fail');
  assert.equal(verdict({ ...exact, overlay: { ...exact.overlay, stale: 1 } }, 'exact').state, 'fail');
  assert.deepEqual(
    parseEvent(`prefix ${marker} {"stage":"capture","trace":7}`),
    { stage: 'capture', trace: 7 },
  );
  assert.equal(parseEvent('unrelated log line'), null);
  console.log('PASS: Symon localization watcher verdicts');
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function run(options) {
  let offset = 0;
  try {
    offset = options.fromStart ? 0 : (await stat(options.log)).size;
  } catch {
    // The packaged app may create its log after the watcher starts.
  }

  console.log(`Watching ${options.log}`);
  console.log(`Expectation: ${options.expect}; timeout: ${options.timeout}s; new events only: ${!options.fromStart}`);
  console.log('Exact test: focus Notes or System Settings, hold Right Option, say "Point at the Search field", then release.');
  console.log('Fn is dictation; Control+Fn is smart compose.');

  const traces = new Map();
  let carry = '';
  let latestTrace = null;
  const deadline = Date.now() + options.timeout * 1000;
  while (Date.now() < deadline) {
    let size = 0;
    try {
      size = (await stat(options.log)).size;
    } catch {
      await sleep(250);
      continue;
    }
    if (size < offset) offset = 0;
    if (size > offset) {
      const handle = await open(options.log, 'r');
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      await handle.close();
      offset = size;
      const lines = (carry + buffer.toString('utf8')).split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseEvent(line);
        if (!event || !event.trace || !['capture', 'model', 'overlay'].includes(event.stage)) continue;
        const trace = String(event.trace);
        latestTrace = trace;
        const stages = traces.get(trace) ?? {};
        stages[event.stage] = event;
        traces.set(trace, stages);
        console.log(`trace=${trace} stage=${event.stage} ${JSON.stringify(event)}`);
        const result = verdict(stages, options.expect);
        if (result.state === 'pass') {
          console.log(`PASS: ${result.reason}`);
          return;
        }
        if (result.state === 'fail') throw new Error(result.reason);
      }
    }
    await sleep(250);
  }
  const stages = latestTrace ? traces.get(latestTrace) ?? {} : {};
  throw new Error(`Timed out. ${timeoutReason(stages)}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) selfTest();
  else await run(options);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
