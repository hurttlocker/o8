/** Shared parsing for credential reads and missing-master-key creation guards. */
export function parseKeyEnv(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return values;
}

export function hasEncryptedKeyValues(raw: string): boolean {
  return [...parseKeyEnv(raw).values()].some(value => value.startsWith('enc:'));
}
