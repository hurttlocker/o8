/** Parse a persisted settings object without letting malformed legacy JSON block startup. */
export function parseStoredJson<T extends object>(raw: string): Partial<T> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Partial<T>;
    }
  } catch {
    // The caller resolves an empty object through its normal defaults.
  }
  return {};
}
