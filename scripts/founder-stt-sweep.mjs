#!/usr/bin/env node
// STT sweep — exercises the REAL /api/dictation/transcribe route (Whisper Turbo via
// OpenRouter) end-to-end: latency + transcript + WER vs known text. Generate the clip
// first: say -o /tmp/stt.aiff "<known text>" && afconvert /tmp/stt.aiff /tmp/stt.wav -d LEI16 -f WAVE
// then: node scripts/founder-stt-sweep.mjs "<known text>"
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KNOWN = process.argv[2] || '';
const WAV = '/tmp/stt.wav';

function apiBase() {
  try { const p = readFileSync(join(homedir(), '.o8', 'api-port'), 'utf8').trim(); if (p) return `http://localhost:${p}`; } catch {}
  return 'http://localhost:3001';
}

// word-level WER (Levenshtein over token sequences / reference length)
function wer(ref, hyp) {
  const norm = (s) => s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const r = norm(ref), h = norm(hyp);
  const d = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = 0; i <= r.length; i++) d[i][0] = i;
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = r[i - 1] === h[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
  return r.length ? d[r.length][h.length] / r.length : 0;
}

(async () => {
  const base = apiBase();
  let buf;
  try { buf = readFileSync(WAV); } catch { console.error(`No ${WAV} — generate it first (see header).`); process.exit(1); }
  const fd = new FormData();
  fd.append('audio', new Blob([buf], { type: 'audio/wav' }), 'stt.wav');

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${base}/api/dictation/transcribe`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60_000) });
  } catch (e) { console.error('request failed:', String(e), `(is the o8 backend up on ${base}?)`); process.exit(1); }
  const dt = ((performance.now() - t0) / 1000).toFixed(2);
  const j = await res.json().catch(() => ({}));

  console.log(`route: ${base}/api/dictation/transcribe  | audio: ${(buf.length / 1024).toFixed(0)} KB`);
  if (!res.ok || j.error) { console.log(`STT FAILED (${res.status}): ${j.error || ''}`); process.exit(1); }
  console.log(`\nlatency: ${dt}s`);
  console.log(`KNOWN:      ${KNOWN}`);
  console.log(`TRANSCRIPT: ${j.text}`);
  if (KNOWN) console.log(`\nWER: ${(wer(KNOWN, j.text) * 100).toFixed(1)}%  (0% = perfect)`);
})();
