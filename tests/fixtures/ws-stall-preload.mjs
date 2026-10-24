// Explicit fixture-only preload. Large-state JSON work models the synchronous
// snapshot bursts implicated in #4367, without adding a production test route.
import { performance } from 'node:perf_hooks';

const snapshot = Array.from({ length: 10_000 }, (_, id) => ({
  id, status: 'running', detail: 'fixture event state '.repeat(12),
}));
process.on('SIGUSR2', () => {
  const until = performance.now() + 300;
  do {
    JSON.parse(JSON.stringify(snapshot));
  } while (performance.now() < until);
});
