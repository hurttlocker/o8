export function shouldApplyAutoRestoreAfterFetch(options: {
  transcriptTouched: boolean;
  threadId: string | null;
}): boolean {
  return !options.transcriptTouched && !options.threadId;
}
