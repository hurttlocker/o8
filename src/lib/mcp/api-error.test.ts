import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, McpInputError, O8ApiError, safeErrorText, unreachableApiError } from './api-error';

afterEach(() => vi.restoreAllMocks());

describe('MCP API error summaries', () => {
  it.each([
    [404, { error: 'packet not found' }, 'packet not found'],
    [400, { error: 'packet\u0000 not found\u001b' }, 'packet not found'],
    [400, { error: 'x'.repeat(200) }, 'x'.repeat(200)],
    [400, { error: 'x'.repeat(201) }, 'o8 API error (400)'],
    [400, { error: 'private\nstack' }, 'o8 API error (400)'],
    [400, { error: 'private\rstack' }, 'o8 API error (400)'],
    [400, { error: 'private\u2028stack' }, 'o8 API error (400)'],
    [400, { error: { message: 'private' } }, 'o8 API error (400)'],
    [500, { error: 'private' }, 'o8 API error (500)'],
    [503, { error: 'private' }, 'o8 API error (503)'],
  ])('bounds status %s summaries', (status, body, summary) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = JSON.stringify(body);
    const error = apiError('/api/fixture', status as number, raw);
    expect(error).toBeInstanceOf(O8ApiError);
    expect(error.status).toBe(status);
    expect(error.summary).toBe(summary);
    expect(error.message).toBe(summary);
    expect(log).toHaveBeenCalledWith('[mcp] API error:', { status, path: '/api/fixture', body: raw }, '');
  });

  it('logs unparseable bodies and network detail while returning fixed summaries', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(apiError('/api/fixture', 400, 'private body').summary).toBe('o8 API error (400)');
    const detail = new Error('private network detail');
    expect(apiError('/api/fixture', null, '', detail).summary).toBe('o8 API error (network)');
    expect(log).toHaveBeenCalledWith('[mcp] API error:', { status: null, path: '/api/fixture', body: '' }, detail);
  });

  it('preserves deliberate input errors and suppresses arbitrary exceptions', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(safeErrorText(new McpInputError('question is required'))).toBe('question is required');
    expect(safeErrorText(new Error('private exception'))).toBe('o8 operation failed');
    expect(safeErrorText('private exception')).toBe('o8 operation failed');
  });

  it('keeps a short single-line error a route reported with ok: false', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(safeErrorText({ ok: false, error: 'surface not found' })).toBe('surface not found');
    expect(safeErrorText({ ok: false, error: { message: 'packet is not in review' } })).toBe('packet is not in review');
    expect(safeErrorText({ ok: false, note: 'already stopped' })).toBe('already stopped');
    expect(safeErrorText({ ok: false, error: 'private\n    at stack' })).toBe('o8 operation failed');
    expect(safeErrorText({ ok: false, error: 'x'.repeat(201) })).toBe('o8 operation failed');
    expect(safeErrorText({ ok: false })).toBe('o8 operation failed');
  });

  it('says the backend is unreachable in fixed text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = unreachableApiError();
    expect(error.status).toBeNull();
    expect(safeErrorText(error)).toBe('o8 API unreachable. Open the o8 desktop app, which starts the backend, or run `npm run desktop:dev` from the o8 repo.');
  });
});
