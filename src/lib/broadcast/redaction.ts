import { homedir } from 'node:os';

const SENSITIVE_KEY = /authorization|bearer|credential|password|secret|token|api.?key|^env(?:ironment)?(?:_?variables?)?$/i;
const GENERIC_HOME_PATHS = [
  /\/Users\/[^/\s]+(?=\/|\b)/g,
  /\/home\/[^/\s]+(?=\/|\b)/g,
  /[A-Za-z]:\\Users\\[^\\\s]+(?=\\|\b)/g,
];

function environmentValues(): string[] {
  return [...new Set(Object.values(process.env)
    .filter((value): value is string => typeof value === 'string' && value.length >= 8))]
    .sort((left, right) => right.length - left.length);
}

export function redactBroadcastText(value: string): string {
  let redacted = value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:o8sp|o8pw|cwk)_[A-Za-z0-9_-]{12,}\b/g, '[redacted-token]');
  const home = homedir();
  if (home && home !== '/') redacted = redacted.split(home).join('~');
  for (const pattern of GENERIC_HOME_PATHS) redacted = redacted.replace(pattern, '~');
  for (const environmentValue of environmentValues()) {
    if (redacted.includes(environmentValue)) {
      redacted = redacted.split(environmentValue).join('[redacted-env]');
    }
  }
  return redacted;
}

export function redactBroadcastValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactBroadcastText(value);
  if (Array.isArray(value)) return value.map((entry) => redactBroadcastValue(entry));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = redactBroadcastValue(entryValue, entryKey);
    }
    return output;
  }
  return value;
}

export function redactBroadcastRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactBroadcastValue(value) as Record<string, unknown>;
}
