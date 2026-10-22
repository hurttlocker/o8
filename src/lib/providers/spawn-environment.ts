import { PROVIDER_ENV_KEYS, PROVIDER_KEY_ALIASES, resolveProviderKey } from './key-store';
import { runtimeBillingMode } from './runtime-billing';

// These aliases have no provider identity. Resolve the selected provider; never trust their literal value.
const SCOPED_ALIASES: Record<string, string> = { O8_FABLE_ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' };
const GENERIC_ALIASES = ['LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN'];
export function providerCredentialName(name: string): boolean {
  return Object.hasOwn(SCOPED_ALIASES, name) || GENERIC_ALIASES.includes(name) || name.endsWith('_API_KEY') || Object.values(PROVIDER_KEY_ALIASES).some(aliases => aliases.includes(name));
}
function genericProvider(input: Record<string, string | undefined>, alias: string): string | null {
  const selected = alias === 'GOOSE_API_KEY' ? input.GOOSE_PROVIDER
    : alias.startsWith('COPILOT_PROVIDER_') ? input.COPILOT_PROVIDER_TYPE : input.LLM_PROVIDER;
  const providers: Record<string, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', google: 'GEMINI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', groq: 'GROQ_API_KEY' };
  const provider = selected?.toLowerCase();
  return provider && Object.hasOwn(providers, provider) ? providers[provider] : null;
}

/** Every provider credential crosses one authority boundary before a local launch or config write. */
export function providerSpawnEnvironment(input: Record<string, string | undefined>, options: { inject?: boolean; clearInherited?: boolean; runtimeId?: string; onlyExisting?: boolean } = {}): Record<string, string> & Pick<NodeJS.ProcessEnv, 'NODE_ENV'> {
  const aliases = [...Object.values(PROVIDER_KEY_ALIASES).flat(), ...GENERIC_ALIASES, ...Object.keys(SCOPED_ALIASES)];
  const canonical = new Set<string>([...PROVIDER_ENV_KEYS, ...Object.keys(input).filter(name => providerCredentialName(name) && !aliases.includes(name))]);
  const credentials = new Set([...canonical, ...aliases]);
  const env = Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined && !credentials.has(entry[0])));
  if (options.clearInherited) for (const name of credentials) env[name] = '';
  const inject = options.inject !== false && (!options.runtimeId || runtimeBillingMode(options.runtimeId) === 'api');
  if (inject) {
    for (const name of canonical) {
      if (options.onlyExisting && !(name in input) && !PROVIDER_KEY_ALIASES[name]?.some(alias => alias in input)) continue;
      if (options.onlyExisting && input[name] === '') { env[name] = ''; continue; }
      const value = resolveProviderKey(name, input);
      if (value) {
        env[name] = value;
        for (const alias of PROVIDER_KEY_ALIASES[name] ?? []) if (!options.onlyExisting || alias in input) env[alias] = value;
      }
    }
    for (const alias of [...GENERIC_ALIASES, ...Object.keys(SCOPED_ALIASES)]) if (alias in input) {
      if (input[alias] === '') { env[alias] = ''; continue; }
      const provider = SCOPED_ALIASES[alias] ?? genericProvider(input, alias);
      const value = provider ? resolveProviderKey(provider, { ...input, [provider]: input[provider] || input[alias] }) : null;
      if (value) env[alias] = value;
    }
  }
  const mode = input.NODE_ENV;
  return { ...env, NODE_ENV: mode === 'development' || mode === 'test' ? mode : 'production' };
}

/** Config env blocks must not acquire unrelated process variables. */
export function providerConfigEnvironment(input: Record<string, string>, runtimeId?: string): Record<string, string> {
  const env: Record<string, string> = providerSpawnEnvironment(input, { onlyExisting: true, runtimeId });
  if (!('NODE_ENV' in input)) delete env.NODE_ENV;
  return env;
}
