import 'server-only';
import { createHash } from 'node:crypto';

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
export interface AcpRegistryAgent {
  id: string; name: string; version: string; description: string; website?: string;
  npm?: { package: string; args: string[] };
  fingerprint: string;
}
export interface AcpRegistryCatalog { agents: AcpRegistryAgent[]; observedAt: string; stale: boolean }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const PINNED_NPM_PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?$/;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;

async function readRegistryBody(response: Response): Promise<string> {
  if (!response.body) throw new Error('The ACP registry response is empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (Number(response.headers.get('content-length')) > MAX_REGISTRY_BYTES) throw new Error('The ACP registry response is too large.');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REGISTRY_BYTES) throw new Error('The ACP registry response is too large.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Registry content is metadata, never a shell command or an automatic install. */
export function decodeAcpRegistry(value: unknown): AcpRegistryAgent[] {
  const data = record(value);
  if (!Array.isArray(data.agents) || data.agents.length > 500) throw new Error('ACP registry format is unavailable.');
  const seen = new Set<string>();
  return data.agents.flatMap(value => {
    const entry = record(value);
    if (typeof entry.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(entry.id) || seen.has(entry.id)
      || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 120 || typeof entry.version !== 'string' || entry.version.length > 80) return [];
    seen.add(entry.id);
    const distribution = record(record(entry.distribution).npx);
    const args = distribution.args ?? [];
    const npm = typeof distribution.package === 'string' && PINNED_NPM_PACKAGE.test(distribution.package)
      && Array.isArray(args) && args.length <= 64 && args.every(arg => typeof arg === 'string' && arg.length < 4096 && !/[\0\r\n]/.test(arg))
      ? { package: distribution.package, args: args as string[] } : undefined;
    const website = [entry.website, entry.repository].find(value => typeof value === 'string' && value.startsWith('https://')) as string | undefined;
    const agent = { id: entry.id, name: entry.name, version: entry.version,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 400) : '', website, npm };
    return [{ ...agent, fingerprint: createHash('sha256').update(JSON.stringify(agent)).digest('hex') }];
  });
}

export function createAcpRegistryReader(fetcher: typeof fetch = fetch) {
  let cached: AcpRegistryCatalog | undefined;
  let pending: Promise<AcpRegistryCatalog> | undefined;
  return async (force = false): Promise<AcpRegistryCatalog> => {
    if (!force && cached && Date.now() - Date.parse(cached.observedAt) < 60 * 60_000) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetcher(REGISTRY_URL, { signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store' });
        if (!response.ok) throw new Error('The ACP registry could not be loaded.');
        const text = await readRegistryBody(response);
        cached = { agents: decodeAcpRegistry(JSON.parse(text)), observedAt: new Date().toISOString(), stale: false };
        return cached;
      } catch {
        if (cached) return { ...cached, stale: true };
        throw new Error('The ACP registry could not be loaded. Retry or connect a local executable.');
      }
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
export const readAcpRegistry = createAcpRegistryReader();
