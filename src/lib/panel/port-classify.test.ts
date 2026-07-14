import { describe, it, expect } from 'vitest';
import { classifyProbe, deriveServerLabel, type HttpProbeResult } from './port-classify';

const probe = (over: Partial<HttpProbeResult>): HttpProbeResult => ({
  reachable: true,
  status: 200,
  contentType: 'text/html',
  ...over,
});

describe('classifyProbe', () => {
  it('classifies a 200 text/html response as a page', () => {
    expect(classifyProbe(probe({ status: 200, contentType: 'text/html; charset=utf-8' }))).toBe('page');
  });

  it('classifies a redirect as a page (web apps bounce / to a sub-path)', () => {
    expect(classifyProbe(probe({ status: 302, contentType: null }))).toBe('page');
    expect(classifyProbe(probe({ status: 308, contentType: 'text/plain' }))).toBe('page');
  });

  it('classifies a 200 JSON response as a service', () => {
    expect(classifyProbe(probe({ status: 200, contentType: 'application/json' }))).toBe('service');
  });

  it('classifies a 200 with no content-type as a service', () => {
    expect(classifyProbe(probe({ status: 200, contentType: null }))).toBe('service');
  });

  it('classifies an unreachable port (no HTTP response) as a service', () => {
    expect(classifyProbe(probe({ reachable: false, status: null, contentType: null }))).toBe('service');
  });

  it('classifies a 4xx/5xx HTML error as a service (not an openable dev server)', () => {
    expect(classifyProbe(probe({ status: 404, contentType: 'text/html' }))).toBe('service');
    expect(classifyProbe(probe({ status: 500, contentType: 'text/html' }))).toBe('service');
  });

  it('treats a completed probe with null status as a service', () => {
    expect(classifyProbe(probe({ reachable: true, status: null }))).toBe('service');
  });
});

describe('deriveServerLabel', () => {
  it('fingerprints Next.js from the renamed process', () => {
    expect(deriveServerLabel('next-server', 'next-server (v16.0.0)')).toBe('Next.js');
  });

  it('fingerprints Next.js from a node next dev command', () => {
    expect(deriveServerLabel('node', '/repo/node_modules/.bin/next dev')).toBe('Next.js');
  });

  it('fingerprints Vite', () => {
    expect(deriveServerLabel('node', '/repo/node_modules/.bin/vite')).toBe('Vite');
  });

  it('fingerprints Python http.server', () => {
    expect(deriveServerLabel('python3', 'python3 -m http.server 8000')).toBe('Python http.server');
  });

  it('fingerprints uvicorn / gunicorn / django', () => {
    expect(deriveServerLabel('python', 'uvicorn app:app')).toBe('Uvicorn');
    expect(deriveServerLabel('python', 'gunicorn wsgi:app')).toBe('Gunicorn');
    expect(deriveServerLabel('python', 'python manage.py runserver')).toBe('Django');
  });

  it('falls back to a friendly runtime name for a bare node process', () => {
    expect(deriveServerLabel('node', '/repo/server.js')).toBe('Dev server');
    expect(deriveServerLabel('python3', 'python3 whatever.py')).toBe('Python server');
  });

  it('falls back to the raw process name when nothing else matches', () => {
    expect(deriveServerLabel('postgres', 'postgres: server process')).toBe('postgres');
  });

  it('handles a missing command string', () => {
    expect(deriveServerLabel('node', null)).toBe('Dev server');
    expect(deriveServerLabel('', null)).toBe('Server');
  });
});
