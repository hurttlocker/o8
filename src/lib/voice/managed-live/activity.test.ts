import { describe, expect, it } from 'vitest';
import { LiveActivity } from './activity';
const speech = (start: number, end: number, output = false, delta = 'hello') => ({ event_id: `${start}:${end}:${output}:${delta}`, type: `session.${output ? 'output' : 'input'}_transcript.delta`, delta, start_ms: start, end_ms: end });
describe('speech-correlated idle policy', () => {
  it('closes at 30 seconds despite continuous noise or UI activity without recognized speech', () => {
    const p = new LiveActivity(0);
    for (let now = 0; now < 30_000; now += 200) expect(p.shouldClose(now, true, false)).toBe(false);
    expect(p.shouldClose(30_000, true, false)).toBe(true);
  });
  it('new meaningful speech extends while replayed, stale and punctuation-only fragments do not', () => {
    const p = new LiveActivity(0); p.observe(speech(9_000, 10_000), 10_000);
    p.observe(speech(9_000, 10_000), 39_000); p.observe(speech(10_000, 11_000), 39_000);
    p.observe(speech(38_000, 39_000, false, '...'), 39_000);
    expect(p.shouldClose(40_000, false, false)).toBe(true);
    p.observe(speech(40_000, 41_000), 41_000);
    expect(p.shouldClose(70_999, false, false)).toBe(false);
    expect(p.shouldClose(71_000, false, false)).toBe(true);
  });
  it('late partial delivery uses its speech interval, not arrival time', () => {
    const p = new LiveActivity(0); p.observe(speech(5_000, 10_000), 18_000);
    expect(p.shouldClose(40_000, false, false)).toBe(true);
  });
  it('protects a long utterance with advancing fragments; energy grace is finite during a transcript outage', () => {
    const p = new LiveActivity(0);
    for (let now = 10_000; now <= 90_000; now += 10_000) { p.observe(speech(now - 1000, now), now); expect(p.shouldClose(now, true, false)).toBe(false); }
    expect(p.shouldClose(120_000, true, false)).toBe(false);
    expect(p.shouldClose(125_000, true, false)).toBe(true);
  });
  it('protects audible output with a quiet tail and a bounded stale-output grace', () => {
    const p = new LiveActivity(0); p.observe(speech(0, 1000, true), 1000);
    expect(p.shouldClose(31_000, false, true)).toBe(false);
    expect(p.shouldClose(31_500, false, false)).toBe(false);
    expect(p.shouldClose(32_000, false, false)).toBe(true);
    expect(p.shouldClose(45_999, false, true)).toBe(false);
    expect(p.shouldClose(46_000, false, true)).toBe(true);
  });
  it('unrecognized remote energy cannot keep alive; backend waiting does not extend', () => {
    expect(new LiveActivity(0).shouldClose(30_000, false, true)).toBe(true);
  });
  it('gives one initial idle window after slow connection readiness without changing usage', () => {
    const p = new LiveActivity(0); p.markReady(35_000); p.markReady(60_000);
    expect(p.shouldClose(64_999, false, false)).toBe(false);
    expect(p.shouldClose(65_000, false, false)).toBe(true);
    expect(p.usage.providerConnectedSeconds).toBeNull();
  });
  it('rejects zero-duration context and malformed intervals, and clamps configured idle bounds', () => {
    const p = new LiveActivity(0);
    for (const [start, end] of [[1000,1000], [2000,1000], [NaN,1000], [0,Infinity], [0,1.5], [0,999999]]) p.observe(speech(start,end), 29_000);
    expect(p.shouldClose(30_000, true, true)).toBe(true);
    expect(p.usage.recognizedSpeechSecondsDiagnostic).toBe(0);
    expect(new LiveActivity(0, -1).idleMs).toBe(15_000);
    expect(new LiveActivity(0, Infinity).idleMs).toBe(30_000);
    expect(new LiveActivity(0, 999999).idleMs).toBe(60_000);
  });
  it('unions overlapping speakers and duplicate/out-of-order intervals without treating them as billable truth', () => {
    const p = new LiveActivity(1000);
    p.observe(speech(1000, 3000), 5000); p.observe(speech(2000, 4000, true), 5000);
    p.observe(speech(1000, 3000), 5000); p.observe(speech(0, 1000), 5000);
    p.observe(speech(-1, 9000), 5000); p.observe(speech(4000, 99_000), 5000);
    expect(p.usage.recognizedSpeechSecondsDiagnostic).toBe(4);
    expect(p.usage.providerConnectedSeconds).toBeNull();
    p.observe({type:'session.usage.updated', usage:{seconds:15}}, 5000);
    p.observe({type:'session.usage.updated', usage:{seconds:12}}, 5000);
    p.observe({type:'session.closed', usage:{seconds:16}}, 5000);
    p.observe({type:'session.usage.updated', usage:{seconds:20}}, 5000);
    expect(p.usage).toEqual({providerConnectedSeconds:16,providerUsageFinal:true,recognizedSpeechSecondsDiagnostic:4});
  });
});
