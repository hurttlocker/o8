/** Local pre-send failure is definite non-submission, unlike an uncertain socket delivery. */
export async function trackComposerSubmission(
  userMessageId: string,
  terminal: (receipt: { userMessageId: string; outcome: 'failed'; text: string }) => void,
  run: (markDispatch: () => void) => Promise<void>,
) {
  let dispatchMayHaveStarted = false;
  try { await run(() => { dispatchMayHaveStarted = true; }); }
  catch { /* Preserve uncertain delivery; never assert a backend stop from a local exception. */ }
  finally {
    if (!dispatchMayHaveStarted) terminal({ userMessageId, outcome: 'failed', text: 'The request was not submitted to the backend. Check the conversation before trying again.' });
  }
}
