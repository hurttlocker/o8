import { describe, expect, it } from 'vitest';
import { sanitizeTranscriptText } from './transcript-sanitize';

describe('sanitizeTranscriptText', () => {
  it('renders a worker self-review as its human summary', () => {
    expect(sanitizeTranscriptText(
      '<self-review> {"passed":true,"confidence":"high","summary":"Added the verification step.","issuesFound":[]} </self-review>',
    )).toBe('Added the verification step.');
  });

  it('drops malformed internal self-review payloads', () => {
    expect(sanitizeTranscriptText('<self-review>not json</self-review>')).toBe('');
  });
});
