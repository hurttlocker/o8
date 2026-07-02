// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeAgentHtml } from './sanitize-html';

// Regression guard for SECURITY_AUDIT_2026-07-02 §CRIT-2. These payloads are the
// exact agent-content vectors the markdown renderer used to pass through raw.
describe('sanitizeAgentHtml', () => {
  it('strips <script>', () => {
    expect(sanitizeAgentHtml('<div>ok</div><script>alert(1)</script>').toLowerCase()).not.toContain('<script');
  });

  it('strips the same-origin <iframe> (the confirmed CRIT-2 exploit)', () => {
    const out = sanitizeAgentHtml(
      '<iframe sandbox="allow-scripts allow-same-origin" srcdoc="<script>fetch(1)</script>"></iframe>',
    ).toLowerCase();
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('srcdoc');
  });

  it('strips SMIL <animate onbegin> (the sanitizer-agnostic SVG vector)', () => {
    const out = sanitizeAgentHtml(
      '<svg><animate onbegin="alert(1)" attributeName="x" dur="1s"/></svg>',
    ).toLowerCase();
    expect(out).not.toContain('onbegin');
    expect(out).not.toContain('<animate');
  });

  it('strips on* handlers and javascript: urls', () => {
    expect(sanitizeAgentHtml('<img src=x onerror="alert(1)">').toLowerCase()).not.toContain('onerror');
    expect(sanitizeAgentHtml('<a href="javascript:alert(1)">a</a>').toLowerCase()).not.toContain('javascript:');
  });

  it('strips <foreignObject> (HTML/script smuggled inside <svg>)', () => {
    expect(
      sanitizeAgentHtml('<svg><foreignObject><script>x()</script></foreignObject></svg>').toLowerCase(),
    ).not.toContain('foreignobject');
  });

  it('keeps benign svg shapes and inline formatting', () => {
    expect(sanitizeAgentHtml('<svg><rect width="10" height="10"/></svg>').toLowerCase()).toContain('rect');
    expect(sanitizeAgentHtml('<strong>bold</strong>').toLowerCase()).toContain('<strong>');
  });
});
