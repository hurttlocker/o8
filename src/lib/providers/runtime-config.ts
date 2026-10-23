import { providerCredentialMaterials } from './key-store';
import { matchesProviderCredential } from './credential-materials';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { writeOwnedRuntimeArtifact } from './owned-artifacts';

const PROVIDER_NAMES = new Set(['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY']);
const PROVIDERS: Record<string, string> = { openai: 'OPENAI_API_KEY', codex: 'OPENAI_API_KEY', 'openai-codex': 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', 'claude-code': 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', google: 'GEMINI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', groq: 'GROQ_API_KEY' };
const providerName = (name: string) => PROVIDER_NAMES.has(name) || ['LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN'].includes(name);
const credentialHeader = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-goog-api-key|xi-api-key|x-auth-token|x-access-token)$/i;

/** Owned files never contain provider secrets. Account OAuth and service auth stay intact. */
export function filterRuntimeConfig(value: unknown, runtimeId: string, provider = runtimeId, location: string[] = [], materials = providerCredentialMaterials()): unknown {
  // payer policy part b: explicit MCP server credentials retain their current behavior.
  if (location.some(part => part === 'mcp_servers' || part === 'mcpServers')) return value;
  if (typeof value === 'string') return matchesProviderCredential(value, materials) ? undefined : value;
  if (Array.isArray(value)) return value.map(item => filterRuntimeConfig(item, runtimeId, provider, location, materials)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const selected = typeof record.provider === 'string' ? record.provider : provider;
  const modelProviders = location.lastIndexOf('model_providers');
  const models = location.lastIndexOf('models');
  const providerMap = modelProviders === location.length - 1 && modelProviders >= 0
    || models >= 0 && location[models + 1] === 'providers' && models + 2 === location.length;
  const providerHeaders = modelProviders >= 0 && location.length > modelProviders + 1
    || models >= 0 && location[models + 1] === 'providers' && location.length > models + 2;
  const providerLocation = location.length === 0 || providerHeaders
    || location[0] === 'model' || (location.includes('providers') && location.some(part => Object.hasOwn(PROVIDERS, part)))
    || (typeof record.provider === 'string' && Object.hasOwn(PROVIDERS, record.provider));
  const out: Record<string, unknown> = {};
  const references: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(record)) {
    if (providerName(name)) continue;
    if (providerLocation && ((location.at(-1) !== 'headers' && /^(api_?key|experimental_bearer_token)$/i.test(name))
      || ((name === 'key' || name === 'token') && (record.type === 'api_key' || record.type === 'api-key')))) continue;
    if (providerHeaders && (name === 'headers' || name === 'http_headers' || name === 'env_http_headers')) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const retained: Record<string, unknown> = {};
      for (const [header, raw] of Object.entries(item)) {
        if (typeof raw === 'string' && matchesProviderCredential(raw, materials)) {
          if (name !== 'env_http_headers' && credentialHeader.test(header) && runtimeId === 'codex' && modelProviders >= 0 && PROVIDERS[selected]) references[header] = PROVIDERS[selected];
          continue;
        }
        if (!credentialHeader.test(header)) retained[header] = raw;
        else if (name === 'env_http_headers' && typeof raw === 'string' && PROVIDER_NAMES.has(raw)) retained[header] = raw;
        else if (name !== 'env_http_headers' && runtimeId === 'codex' && modelProviders >= 0 && PROVIDERS[selected]) references[header] = PROVIDERS[selected];
      }
      out[name] = retained;
    } else {
      const filtered = filterRuntimeConfig(item, runtimeId, Object.hasOwn(PROVIDERS, name) ? name : providerMap ? '' : selected, [...location, name], materials);
      if (filtered !== undefined) out[name] = filtered;
    }
  }
  if (Object.keys(references).length) out.env_http_headers = { ...references, ...(out.env_http_headers as object ?? {}) };
  if (runtimeId === 'codex' && out.auth_mode === 'apikey') delete out.auth_mode;
  return out;
}

function parseWithoutSecrets<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new Error('Runtime credential configuration is invalid. Fix its syntax and retry.'); }
}

/** Parse before writing a destination, so even interrupted preparation has no plaintext window. */
export function sanitizeRuntimeConfigText(file: string, raw: string, runtimeId: string): string {
  if (file.endsWith('.json')) return `${JSON.stringify(filterRuntimeConfig(parseWithoutSecrets(() => JSON.parse(raw)), runtimeId) ?? null, null, 2)}\n`;
  if (file.endsWith('.toml')) {
    const original = parseWithoutSecrets(() => parseToml(raw));
    const filtered = filterRuntimeConfig(original, runtimeId) as Record<string, unknown>;
    return JSON.stringify(original) === JSON.stringify(filtered) && !matchesProviderCredential(raw, providerCredentialMaterials()) ? raw : stringifyToml(filtered);
  }
  if (file.endsWith('.yaml') || file.endsWith('.yml')) return stringifyYaml(filterRuntimeConfig(parseWithoutSecrets(() => parseYaml(raw)), runtimeId));
  const materials = providerCredentialMaterials();
  return raw.split('\n').filter(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return (!match || !providerName(match[1])) && !matchesProviderCredential(line, materials);
  }).join('\n');
}

export function copyRuntimeConfigFile(source: string, destination: string, runtimeId: string): void {
  writeOwnedRuntimeArtifact(destination, runtimeId, readFileSync(source, 'utf8'));
}

/** Reconcile and register existing owned profiles on every preparation. */
export function reconcileRuntimeConfigFile(file: string, runtimeId: string): void {
  if (!existsSync(file)) return;
  if (!lstatSync(file).isFile()) throw new Error('Runtime credential overlays must be regular files.');
  writeOwnedRuntimeArtifact(file, runtimeId, readFileSync(file, 'utf8'));
}
