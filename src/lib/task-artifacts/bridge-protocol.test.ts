import { describe, expect, it } from 'vitest';
import { mintBridgeToken, TASK_ARTIFACT_BRIDGE_VERSION, TASK_ARTIFACT_FRAME_BOOTSTRAP, validateFrameMessage } from './bridge-protocol';
import { buildTaskArtifactSrcdoc, TASK_ARTIFACT_CSP } from './srcdoc';
import { TASK_ARTIFACT_LIMITS } from './types';

const token = mintBridgeToken();
const declared = ['submit'];
const good = { sourceIsFrame: true, token, declaredActions: declared };

describe('validateFrameMessage (hostile frame gate)', () => {
  it('accepts ready before a token exists, but only with the current bridge version', () => {
    expect(validateFrameMessage({ ...good, token: null, data: { type: 'o8:ready', bridge: TASK_ARTIFACT_BRIDGE_VERSION } })).toMatchObject({ ok: true });
    expect(validateFrameMessage({ ...good, token: null, data: { type: 'o8:ready', bridge: 99 } })).toMatchObject({ ok: false });
  });

  it('refuses anything that did not come from the artifact frame', () => {
    const verdict = validateFrameMessage({ ...good, sourceIsFrame: false, data: { type: 'o8:submit', token, requestId: 'r1', action: 'submit', payload: {} } });
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining('did not come from the artifact frame') });
  });

  it('refuses a wrong or missing capability token', () => {
    expect(validateFrameMessage({ ...good, data: { type: 'o8:submit', token: 'stolen', requestId: 'r1', action: 'submit', payload: {} } }))
      .toMatchObject({ ok: false, reason: 'capability token mismatch' });
    expect(validateFrameMessage({ ...good, data: { type: 'o8:submit', requestId: 'r1', action: 'submit', payload: {} } }))
      .toMatchObject({ ok: false, reason: 'capability token mismatch' });
    expect(validateFrameMessage({ ...good, token: null, data: { type: 'o8:height', token, height: 10 } }))
      .toMatchObject({ ok: false, reason: 'frame is not initialized' });
  });

  it('refuses undeclared actions, non-object payloads, and unknown message types', () => {
    expect(validateFrameMessage({ ...good, data: { type: 'o8:submit', token, requestId: 'r1', action: 'delete-repo', payload: {} } }))
      .toMatchObject({ ok: false, reason: 'action "delete-repo" was not declared' });
    expect(validateFrameMessage({ ...good, data: { type: 'o8:submit', token, requestId: 'r1', action: 'submit', payload: 'rm -rf' } }))
      .toMatchObject({ ok: false, reason: 'payload must be an object' });
    expect(validateFrameMessage({ ...good, data: { type: 'o8:fetch', token, url: 'http://127.0.0.1/api/panel/dev-server' } }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('unknown message type') });
    expect(validateFrameMessage({ ...good, data: 'string' })).toMatchObject({ ok: false, reason: 'malformed message' });
  });

  it('bounds payload, draft, and height', () => {
    const big = { blob: 'x'.repeat(TASK_ARTIFACT_LIMITS.payloadMaxBytes + 1) };
    expect(validateFrameMessage({ ...good, data: { type: 'o8:submit', token, requestId: 'r1', action: 'submit', payload: big } }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('size limit') });
    const bigDraft = { blob: 'x'.repeat(TASK_ARTIFACT_LIMITS.draftMaxBytes + 1) };
    expect(validateFrameMessage({ ...good, data: { type: 'o8:draft', token, draft: bigDraft } }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('size limit') });
    expect(validateFrameMessage({ ...good, data: { type: 'o8:height', token, height: -1 } })).toMatchObject({ ok: false });
    expect(validateFrameMessage({ ...good, data: { type: 'o8:height', token, height: 240.6 } })).toMatchObject({ ok: true, message: { height: 241 } });
  });

  it('passes a well-formed submit through unchanged', () => {
    const payload = { rows: [{ issue: 1699, priority: 'p1' }] };
    const verdict = validateFrameMessage({ ...good, data: { type: 'o8:submit', token, requestId: 'r7', action: 'submit', payload } });
    expect(verdict).toEqual({ ok: true, message: { type: 'o8:submit', token, requestId: 'r7', action: 'submit', payload } });
  });
});

describe('sandboxed document', () => {
  it('locks down network, forms, navigation, and nested browsing in the CSP', () => {
    for (const directive of ["connect-src 'none'", "form-action 'none'", "frame-src 'none'", "child-src 'none'", "object-src 'none'", "base-uri 'none'"]) {
      expect(TASK_ARTIFACT_CSP).toContain(directive);
    }
    expect(TASK_ARTIFACT_CSP).not.toMatch(/connect-src[^;]*(self|\*|http)/);
  });

  it('injects the CSP and the bridge before the agent html', () => {
    const doc = buildTaskArtifactSrcdoc('<!doctype html><h1>hi</h1><script>window.o8.onCollect(() => ({}))</script>', {
      background: '#111', text: '#eee', textMuted: '#999', border: '#333', accent: '#e8a33d', fontFamily: 'system-ui',
    });
    const csp = doc.indexOf('Content-Security-Policy');
    const bridge = doc.indexOf(TASK_ARTIFACT_FRAME_BOOTSTRAP.slice(0, 40));
    const agent = doc.indexOf('<h1>hi</h1>');
    expect(csp).toBeGreaterThan(0);
    expect(bridge).toBeGreaterThan(csp);
    expect(agent).toBeGreaterThan(bridge);
    expect(doc.match(/<!doctype/gi)?.length).toBe(1);
  });

  it('exposes only the o8 bridge surface to the frame', () => {
    expect(TASK_ARTIFACT_FRAME_BOOTSTRAP).toContain('window.o8 = {');
    expect(TASK_ARTIFACT_FRAME_BOOTSTRAP).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|document\.cookie/);
  });
});
