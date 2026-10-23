import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { providerCredentialName, providerSpawnEnvironment, providerConfigEnvironment } from './spawn-environment';
import { runtimeBillingMode } from './runtime-billing';
import { parseKeyEnv } from './env-format';
import { PROVIDER_KEY_ALIASES } from './key-store';

const PROVIDERS: Record<string, string> = { openai: 'OPENAI_API_KEY', codex: 'OPENAI_API_KEY', 'openai-codex': 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', 'claude-code': 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', google: 'GEMINI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', groq: 'GROQ_API_KEY' };

/** Sanitize o8-owned overlays, preserving account OAuth and non-provider MCP authentication. */
export function filterRuntimeConfig(value: unknown, runtimeId: string, provider = runtimeId, location: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(item => filterRuntimeConfig(item, runtimeId, provider, location));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const selected = typeof record.provider === 'string' ? record.provider : provider;
  const providerMap = (location.length === 1 && location[0] === 'model_providers')
    || (location.length === 2 && location[0] === 'models' && location[1] === 'providers');
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(record)) {
    if (name === 'headers' || name === 'http_headers' || name === 'env_http_headers') {
      const providerHeaders = (location[0] === 'models' && location[1] === 'providers' && location.length >= 3)
        || (location[0] === 'model_providers' && location.length >= 2);
      out[name] = providerHeaders ? filterProviderHeaders(item, runtimeId, selected, name === 'env_http_headers') : item;
    } else if (name === 'env' && item && typeof item === 'object' && !Array.isArray(item)) {
      out[name] = providerConfigEnvironment(item as Record<string, string>, runtimeId);
    } else if (providerCredentialName(name) && typeof item === 'string') {
      const resolved = providerSpawnEnvironment({ [name]: item }, { runtimeId, onlyExisting: true });
      if (resolved[name]) out[name] = resolved[name];
    } else if (/^(api_?key|experimental_bearer_token)$/i.test(name) || ((name === 'key' || name === 'token') && (record.type === 'api_key' || record.type === 'api-key'))) {
      const canonical = Object.hasOwn(PROVIDERS, selected) ? PROVIDERS[selected] : undefined;
      const resolved = canonical && typeof item === 'string' ? providerSpawnEnvironment({ [canonical]: item }, { runtimeId, onlyExisting: true })[canonical] : null;
      if (resolved) out[name] = resolved;
    } else {
      out[name] = filterRuntimeConfig(item, runtimeId, Object.hasOwn(PROVIDERS, name) ? name : providerMap ? '' : selected, [...location, name]);
    }
  }
  if (runtimeId === 'codex' && runtimeBillingMode(runtimeId) === 'subscription' && out.auth_mode === 'apikey') out.auth_mode = 'chatgpt';
  return out;
}

function filterProviderHeaders(headers: unknown, runtimeId: string, provider: string, environmentReferences = false): unknown {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const canonical = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined;
  return Object.fromEntries(Object.entries(headers).flatMap(([name, raw]) => {
    if (!/^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-goog-api-key|xi-api-key|x-auth-token|x-access-token)$/i.test(name)) return [[name, raw]];
    if (!canonical || typeof raw !== 'string') return [];
    if (environmentReferences) {
      // Unknown environment names cannot be reconciled with the canonical store.
      if (raw !== canonical && !PROVIDER_KEY_ALIASES[canonical]?.includes(raw)) return [];
      const env = providerSpawnEnvironment({ [raw]: process.env[raw] }, { runtimeId, onlyExisting: true });
      return env[raw] ? [[name, raw]] : [];
    }
    const prefix = /^(Bearer|Token)\s+/i.exec(raw)?.[0] ?? '';
    const value = providerSpawnEnvironment({ [canonical]: raw.slice(prefix.length) }, { runtimeId, onlyExisting: true })[canonical];
    return value ? [[name, `${prefix}${value}`]] : [];
  }));
}

/** Reconcile every launch, including profiles already seeded before a revocation or restart. */
export function reconcileRuntimeConfigFile(file: string, runtimeId: string): void {
  if (!existsSync(file)) return;
  if (!lstatSync(file).isFile()) throw new Error('Runtime credential overlays must be regular files.');
  const raw = readFileSync(file, 'utf8');
  let next: string;
  if (file.endsWith('.json')) next = `${JSON.stringify(filterRuntimeConfig(JSON.parse(raw), runtimeId), null, 2)}\n`;
  else if (file.endsWith('.toml')) {
    const original = parseToml(raw); const filtered = filterRuntimeConfig(original, runtimeId) as Record<string, unknown>;
    next = JSON.stringify(original) === JSON.stringify(filtered) ? raw : stringifyToml(filtered);
  }
  else if (file.endsWith('.yaml') || file.endsWith('.yml')) next = stringifyYaml(filterRuntimeConfig(parseYaml(raw), runtimeId));
  else {
    const input = Object.fromEntries(parseKeyEnv(raw.replace(/^\s*export\s+/gm, '')));
    const env = providerSpawnEnvironment(input, { runtimeId, onlyExisting: true });
    next = raw.split('\n').map(line => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return match && providerCredentialName(match[1]) ? (env[match[1]] ? `${match[1]}=${JSON.stringify(env[match[1]])}` : '') : line;
    }).join('\n');
  }
  if (raw !== next) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  }
}
