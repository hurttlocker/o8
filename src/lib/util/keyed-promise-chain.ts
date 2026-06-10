/**
 * Keyed promise-chain serialization — the single shared implementation of the
 * "per-key async mutex" used by the merge path (per-repo) and the owned-session
 * store (per-surface).
 *
 * Semantics:
 *   - Calls with the same key run strictly in submission order, one at a time.
 *   - Calls with different keys run concurrently.
 *   - A rejected fn does NOT poison the chain: the next caller still runs
 *     (`prev.then(fn, fn)`), and the rejection propagates only to the caller
 *     that scheduled it.
 *
 * Single-process by design — this guards in-process read-modify-write races,
 * not cross-process ones.
 */
export function chainOnKey<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Park a settled-safe tail so an error in `run` can't reject a future
  // caller's `prev` and so the map never holds a rejected promise.
  chains.set(key, run.then(() => undefined, () => undefined));
  return run;
}
