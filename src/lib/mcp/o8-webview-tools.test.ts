import { describe, it, expect } from 'vitest';
import { buildSemanticClickExpr } from './o8-webview-tools';

// #agent-surface-ergonomics — the semantic-locator click is generated as in-page
// code, so the risk is malformed/escaped output (the live DOM behavior is
// verified in-app). These lock the code-gen: valid JS, correctly-injected,
// JSON-escaped locator values.
describe('buildSemanticClickExpr', () => {
  it('emits a syntactically valid IIFE expression', () => {
    const code = buildSemanticClickExpr({ text: 'New session', role: '', name: '' });
    // new Function parses but does not execute — validates syntax without a DOM.
    expect(() => new Function(`return ${code};`)).not.toThrow();
  });

  it('injects the text locator JSON-escaped (no injection break on quotes)', () => {
    const code = buildSemanticClickExpr({ text: 'New "session"', role: '', name: '' });
    expect(code).toContain('const TEXT = "New \\"session\\""');
    expect(() => new Function(`return ${code};`)).not.toThrow();
  });

  it('injects role + name for aria targeting', () => {
    const code = buildSemanticClickExpr({ text: '', role: 'button', name: 'Restart' });
    expect(code).toContain('ROLE = "button"');
    expect(code).toContain('NAME = "Restart"');
  });

  it('preserves a real \\s regex (whitespace normalizer survives templating)', () => {
    const code = buildSemanticClickExpr({ text: 'x', role: '', name: '' });
    expect(code).toContain('replace(/\\s+/g');
  });
});
