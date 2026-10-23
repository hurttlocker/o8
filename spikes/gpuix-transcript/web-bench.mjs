// Executed by page.evaluate, entirely in the isolated WebKit page.
export async function webBench() {
  const bench = window.bench;
  const fixtureHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(bench.fixture()))))).map(value => value.toString(16).padStart(2, '0')).join('');
  const samples = { stream: [], keys: [], scroll: [] };
  const observations = [];
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) observations.push(entry.toJSON());
  });
  observer.observe({ entryTypes: ['measure'] });
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  async function measure(kind, action) {
    const id = `${kind}-${samples[kind].length}`;
    performance.mark(`${id}-start`);
    const start = performance.now();
    action();
    // Force layout after React's synchronous commit, inside the measured task.
    const field = document.querySelector('textarea');
    const height = document.querySelector('main').getBoundingClientRect().height;
    const input = field.value;
    const costMs = performance.now() - start;
    await frame(); await frame();
    performance.mark(`${id}-frame`);
    performance.measure(id, `${id}-start`, `${id}-frame`);
    samples[kind].push({ elapsedMs: performance.now() - start, costMs, input, height });
  }
  bench.scroll(1999); await frame(); await frame();
  const streamStart = performance.now();
  for (let n = 1; n <= 80; n++) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, streamStart + n * 20 - performance.now())));
    await measure('stream', () => bench.stream(n));
    if (n % 4 === 0) await measure('keys', () => bench.key());
  }
  const streamMs = performance.now() - streamStart;
  for (let n = 0; n < 2000; n += 20) await measure('scroll', () => bench.scroll(Math.min(n + 19, 1999)));
  await new Promise(resolve => setTimeout(resolve, 0));
  observer.disconnect();
  const state = bench.state();
  if (state.input !== 'w'.repeat(20) || state.rows !== 2000 || state.tokens !== 80) throw Error('Web fixture acknowledgement failed');
  return { surface: 'web', fixtureHash, ...samples, observations, rows: state.rows,
    width: innerWidth, height: innerHeight, inputAcknowledged: state.input.length,
    tokens: state.tokens, streamMs, tokensPerSecond: 80 / (streamMs / 1000),
    measurement: 'Headless WebKit synchronous JS/React/layout task and dispatch-to-second-rAF; no displayed frame' };
}
