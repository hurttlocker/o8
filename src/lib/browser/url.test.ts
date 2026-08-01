import { describe, expect, it } from 'vitest';

import {
  browserFrameSrc,
  browserTitleFromUrl,
  isLoopbackBrowserUrl,
  normalizeBrowserUrl,
} from './url';

describe('browser URL helpers', () => {
  it('normalizes addresses consistently across browser surfaces', () => {
    expect(normalizeBrowserUrl('')).toBe('');
    expect(normalizeBrowserUrl(' https://example.com/path ')).toBe('https://example.com/path');
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeBrowserUrl('127.0.0.1:47100')).toBe('http://127.0.0.1:47100');
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com');
  });

  it('recognizes local and private development hosts', () => {
    expect(isLoopbackBrowserUrl('http://localhost:3000')).toBe(true);
    expect(isLoopbackBrowserUrl('http://10.0.0.7:3000')).toBe(true);
    expect(isLoopbackBrowserUrl('http://172.20.0.7:3000')).toBe(true);
    expect(isLoopbackBrowserUrl('http://192.168.1.7:3000')).toBe(true);
    expect(isLoopbackBrowserUrl('https://example.com')).toBe(false);
    expect(isLoopbackBrowserUrl('file:///tmp/index.html')).toBe(false);
  });

  it('proxies local pages while leaving external pages alone', () => {
    expect(browserFrameSrc('http://localhost:3000/path')).toBe(
      '/api/browser/proxy?url=http%3A%2F%2Flocalhost%3A3000%2Fpath',
    );
    expect(browserFrameSrc('https://example.com')).toBe('https://example.com');
  });

  it('builds stable tab titles', () => {
    expect(browserTitleFromUrl('http://localhost:3000/path')).toBe('localhost:3000');
    expect(browserTitleFromUrl('https://www.example.com/path')).toBe('example.com');
    expect(browserTitleFromUrl('')).toBe('New Tab');
  });
});
