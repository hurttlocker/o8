/**
 * In-chat error notices — the system entries that report a turn failing
 * (delivery failure, orchestrator stream error) rather than reporting normal
 * lifecycle news.
 *
 * New entries carry `isError` from their creator. Threads persisted before the
 * flag existed only have their text, so the detector below re-derives the flag
 * on render — same no-migration trick `detectOrchestratorStatusEvent` uses, so
 * old threads tidy in place.
 */

/** Leading text of every error notice we create. Match is prefix-based: the
 *  notices append detail (the error string, the original prompt) after this. */
const ERROR_NOTICE_PREFIXES = [
  'Orchestrator error',
  'Message may not have been delivered',
  "Couldn't reach the orchestrator",
];

export function isErrorNoticeText(text: string | undefined | null): boolean {
  if (!text) return false;
  const head = text.trimStart();
  return ERROR_NOTICE_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/** Resolves the error flag for a system entry: explicit flag wins, text
 *  detection covers entries persisted before the flag shipped. */
export function resolveIsErrorNotice(entry: { isError?: boolean; text?: string }): boolean {
  return entry.isError ?? isErrorNoticeText(entry.text);
}
