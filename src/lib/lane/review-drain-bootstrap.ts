import { startReviewQueueDrain } from './auto-review';

// Instrumentation and route bundles can load separate copies of this module.
// The queue processor belongs to the server process, not one request bundle.
const runtime = globalThis as typeof globalThis & {
  __o8ReviewQueueDrain?: { stop: () => void };
};

export function ensureReviewQueueDrainStarted(): void {
  if (runtime.__o8ReviewQueueDrain) return;
  const stop = startReviewQueueDrain();
  runtime.__o8ReviewQueueDrain = { stop };
}
