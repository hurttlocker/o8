import os from 'node:os';

const REDACTED_PATH = '[redacted-path]';
const STACK_TRACE_PREFIX = /^\s*at\s+/;
const FILE_PATH_PATTERN = /(?:[A-Za-z]:)?(?:\/[^/\s'"]+)+/g;

function normalizeMessage(value: string) {
  const firstMeaningfulLine = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !STACK_TRACE_PREFIX.test(line))
    ?? '';

  return firstMeaningfulLine.replace(/\s+/g, ' ').trim();
}

function redactKnownRoots(value: string) {
  const roots = [process.cwd(), process.env.HOME || os.homedir()]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  let sanitized = value;
  for (const root of roots) {
    sanitized = sanitized.split(root).join(REDACTED_PATH);
  }

  return sanitized.replace(FILE_PATH_PATTERN, (match) => {
    if (match === '/api' || match.startsWith('/api/') || match.startsWith('/v1/') || match.startsWith('/v2/')) {
      return match;
    }
    if (match.startsWith('//')) {
      return match;
    }
    return REDACTED_PATH;
  });
}

export function sanitizeErrorMessage(error: unknown, fallback = 'Internal error') {
  let raw = fallback;

  if (error instanceof Error && error.message.trim()) {
    raw = error.message;
  } else if (typeof error === 'string' && error.trim()) {
    raw = error;
  }

  const normalized = normalizeMessage(raw);
  if (!normalized) {
    return fallback;
  }

  const sanitized = redactKnownRoots(normalized).replace(/\s+/g, ' ').trim();
  return sanitized || fallback;
}

export function buildErrorPayload(error: string, detail?: unknown) {
  const sanitizedDetail = detail === undefined ? '' : sanitizeErrorMessage(detail, '');
  if (sanitizedDetail && sanitizedDetail !== error) {
    return { error, detail: sanitizedDetail };
  }
  return { error };
}
