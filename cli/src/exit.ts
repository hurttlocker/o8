/** Complete one-shot replies before exiting, without retaining unrelated handles. */
const FLUSH_TIMEOUT_MS = 10_000;

type FlushResult = 'complete' | 'closed' | 'failed';

function streamFailure(error: unknown): FlushResult {
  // A consumer such as `head` deliberately closes early. Preserve that normal
  // pipe behavior without printing a stack trace. Other write failures are not OK.
  return (error as NodeJS.ErrnoException | null)?.code === 'EPIPE' ? 'closed' : 'failed';
}

function flushStream(stream: NodeJS.WriteStream, timeoutMs: number): Promise<FlushResult> {
  if (stream.errored) return Promise.resolve(streamFailure(stream.errored));
  if (stream.destroyed) return Promise.resolve('closed');
  if (stream.writableLength === 0) return Promise.resolve('complete');

  return new Promise<FlushResult>((resolve) => {
    let settled = false;
    const finish = (result: FlushResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish('failed'), timeoutMs);
    // Keep the error handler until the imminent process exit: a write callback
    // can settle first and its corresponding error event can follow afterward.
    stream.on('error', (error) => finish(streamFailure(error)));
    try {
      // This callback queues behind previous writes, including backpressured
      // data that has not yet reached the OS pipe.
      stream.write('', (error) => finish(error ? streamFailure(error) : 'complete'));
    } catch (error) {
      finish(streamFailure(error));
    }
  });
}

export async function exitAfterFlush(code: number): Promise<never> {
  const results = await Promise.all([
    flushStream(process.stdout, FLUSH_TIMEOUT_MS),
    flushStream(process.stderr, FLUSH_TIMEOUT_MS),
  ]);
  if (!results.includes('failed') || code !== 0) process.exit(code);

  // Do not append another JSON object to a command's existing error response.
  // A successful command whose output could not drain instead gets a nonzero
  // exit and, when stderr is available, a small structured diagnostic.
  if (results[1] === 'complete') {
    process.stderr.write(`${JSON.stringify({
      schema: 'o8/cli/error/v1',
      error: {
        code: 'output_incomplete',
        message: 'Command output could not finish writing. The command may have completed; check its state before retrying.',
        hint: 'Redirect output to a file or use a consumer that reads it promptly.',
        ambiguous: true,
      },
    })}\n`);
    await flushStream(process.stderr, 250);
  }
  process.exit(1);
}
