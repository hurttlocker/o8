const writes = new Map<string, Set<Promise<void>>>();
const keyFor = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
/** A concurrent read waits until a local posting result can identify its own remark. */
export function beginPrRemarkWrite(repo: string, number: number): () => void {
  const key = keyFor(repo, number);
  if (writes.size >= 64 && !writes.has(key)) throw new Error('Too many pull request updates are pending. Retry.');
  const group = writes.get(key) ?? new Set<Promise<void>>();
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; }); group.add(pending); writes.set(key, group);
  return () => { group.delete(pending); if (!group.size && writes.get(key) === group) writes.delete(key); resolve(); };
}
export async function waitForPrRemarkWrites(repo: string, number: number): Promise<void> {
  const group = writes.get(keyFor(repo, number)); if (!group?.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all([...group]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('A pull request update is still pending. Retry.')), 18_000); })]);
    // Another local write may have begun while the first group was settling.
    if (writes.get(keyFor(repo, number))?.size) throw new Error('A pull request update is still pending. Retry.');
  } finally { clearTimeout(timer); }
}
