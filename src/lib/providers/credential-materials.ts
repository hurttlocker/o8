import { createHash } from 'node:crypto';
import { providerCredentialMaterials, type ProviderCredentialMaterials } from './key-store';

const historicalHashes = new WeakMap<ProviderCredentialMaterials, ReadonlySet<string>>();

/** Field-independent matching of current and retired provider material. */
export function matchesProviderCredential(value: string, materials: ProviderCredentialMaterials): boolean {
  if (materials.values.some(secret => value.includes(secret))) return true;
  let hashes = historicalHashes.get(materials);
  if (!hashes) {
    const remaining = new Set(materials.hashes);
    for (const secret of materials.values) remaining.delete(createHash('sha256').update(secret).digest('hex'));
    hashes = remaining; historicalHashes.set(materials, hashes);
  }
  if (!hashes.size) return false;
  const bytes = Buffer.from(value);
  for (const length of materials.lengths) for (let offset = 0; offset + length <= bytes.length; offset++) {
    if (hashes.has(createHash('sha256').update(bytes.subarray(offset, offset + length)).digest('hex'))) return true;
  }
  return false;
}

/** Allowed values are explicit provider slots already authorized by the launch policy. */
export function containsProviderCredential(value: string, allowed: ReadonlySet<string> = new Set()): boolean {
  const materials = providerCredentialMaterials();
  if (!allowed.size) return matchesProviderCredential(value, materials);
  const hashes = new Set(materials.hashes);
  for (const secret of allowed) hashes.delete(createHash('sha256').update(secret).digest('hex'));
  return matchesProviderCredential(value, { ...materials, hashes, values: materials.values.filter(secret => !allowed.has(secret)) });
}
