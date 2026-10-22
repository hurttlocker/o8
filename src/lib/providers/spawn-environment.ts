import { PROVIDER_ENV_KEYS, PROVIDER_KEY_ALIASES, resolveProviderKey } from './key-store';

/** Every provider credential crosses one authority boundary before a local launch. */
export function providerSpawnEnvironment(input: Record<string, string | undefined>, options: { inject?: boolean; clearInherited?: boolean } = {}): Record<string, string> & Pick<NodeJS.ProcessEnv, 'NODE_ENV'> {
  const aliases = Object.values(PROVIDER_KEY_ALIASES).flat();
  const canonical = new Set<string>([...PROVIDER_ENV_KEYS, ...Object.keys(input).filter(name => name.endsWith('_API_KEY') && !aliases.includes(name))]);
  const credentials = new Set([...canonical, ...aliases]);
  const env = Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined && !credentials.has(entry[0])));
  // PTY daemons merge another process environment. Explicit blanks prevent resurrection.
  if (options.clearInherited) for (const name of credentials) env[name] = '';
  if (options.inject !== false) for (const name of canonical) {
    const value = (PROVIDER_ENV_KEYS as readonly string[]).includes(name) ? resolveProviderKey(name) : resolveProviderKey(name, input);
    if (value) {
      env[name] = value;
      for (const alias of PROVIDER_KEY_ALIASES[name] ?? []) env[alias] = value;
    }
  }
  const mode = input.NODE_ENV;
  return { ...env, NODE_ENV: mode === 'development' || mode === 'test' ? mode : 'production' };
}
