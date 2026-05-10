import assert from 'node:assert/strict';

import {
  isNullObjectScreenshotPanic,
  pickWindowCaptureRect,
  screenshotCommandErrorMessage,
  sendScreenshotWithFallback,
} from '@/lib/mcp/o8-screenshot-fallback';

const panicMessage = 'Window operation failed: Task join error: task 77 panicked with message "Attempted to create a NULL object."';

assert.equal(
  screenshotCommandErrorMessage({ success: false, error: panicMessage }),
  panicMessage,
);
assert.equal(
  screenshotCommandErrorMessage({ data: { success: false, error: 'nested failure' } }),
  'nested failure',
);
assert.equal(isNullObjectScreenshotPanic(new Error(panicMessage)), true);
assert.deepEqual(
  pickWindowCaptureRect({
    windows: [
      { label: 'popover', visible: true, position: { x: 1, y: 2 }, size: { width: 3, height: 4 } },
      { label: 'main', visible: true, position: { x: 10.4, y: 20.5 }, size: { width: 800.2, height: 600.8 } },
    ],
  }, 'main'),
  { x: 10, y: 21, width: 800, height: 601 },
);

const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l4dZLgAAAABJRU5ErkJggg==';

async function run() {
  const commands: string[] = [];
  let resets = 0;
  const result = await sendScreenshotWithFallback(
    async (command) => {
      commands.push(command);
      if (command === 'take_screenshot') {
        return { success: false, error: panicMessage };
      }
      return { windows: [{ label: 'main', visible: true, position: { x: 1, y: 2 }, size: { width: 3, height: 4 } }] };
    },
    () => { resets += 1; },
    'main',
    async (getAppInfo, windowLabel) => {
      assert.equal(windowLabel, 'main');
      assert.ok(pickWindowCaptureRect(await getAppInfo(), windowLabel));
      return { imageBase64: png1x1, mimeType: 'image/png' };
    },
  );

  assert.deepEqual(commands, ['take_screenshot', 'get_app_info']);
  assert.equal(resets, 1);
  assert.deepEqual(result, {
    success: true,
    data: `data:image/png;base64,${png1x1}`,
  });

  await assert.rejects(
    () => sendScreenshotWithFallback(
      async () => ({ success: false, error: 'Screen Recording permission required' }),
      () => { resets += 1; },
      'main',
      async () => ({ imageBase64: png1x1, mimeType: 'image/png' }),
    ),
    (error) => error instanceof Error && error.message === 'Screen Recording permission required',
  );

  console.log('screenshot fallback smoke passed');
}

run().catch((error) => {
  console.error('screenshot fallback smoke failed:', error);
  process.exitCode = 1;
});
