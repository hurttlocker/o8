import "server-only";

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { cliInvocation } from "./cli-spawn";
import { OPENCODE_PROVIDER_ENVIRONMENT_KEYS } from "./opencode-provider-environments";

const execFileAsync = promisify(execFile);
const SERVICE_PROBE_TIMEOUT_MS = 1_500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function uniquePaths(paths: Array<string | null>): string[] {
  return [
    ...new Set(
      paths.filter((candidate): candidate is string => Boolean(candidate)),
    ),
  ];
}

function stripJsonCommentsAndTrailingCommas(text: string): string {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        withoutComments += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n" || char === "\r") {
        withoutComments += char;
      }
      continue;
    }
    if (inString) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    withoutComments += char;
  }

  let result = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (/\s/.test(withoutComments[cursor] ?? "")) cursor += 1;
      if (withoutComments[cursor] === "}" || withoutComments[cursor] === "]")
        continue;
    }
    result += char;
  }
  return result;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(text));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readJsonRecord(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonRecord(await readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function mergeRecords(
  base: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(update)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      continue;
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value)
        ? mergeRecords(current, value)
        : value;
  }
  return merged;
}

function globalConfigDirectory(home: string): string {
  const configHome =
    nonEmptyEnv("XDG_CONFIG_HOME") ??
    nonEmptyEnv("APPDATA") ??
    nonEmptyEnv("LOCALAPPDATA") ??
    path.join(home, ".config");
  return path.join(configHome, "opencode");
}

function configFiles(directory: string, includeLegacy = false): string[] {
  return [
    ...(includeLegacy ? [path.join(directory, "config.json")] : []),
    path.join(directory, "opencode.json"),
    path.join(directory, "opencode.jsonc"),
  ];
}

async function projectDirectories(cwd: string): Promise<string[]> {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    directories.push(current);
    if (await fileExists(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function projectConfigDisabled(): boolean {
  const value = process.env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase();
  return value === "true" || value === "1";
}

export async function readOpencodeConfig(
  home: string,
  cwd?: string | null,
): Promise<Record<string, unknown>> {
  let config: Record<string, unknown> = {};
  const mergeFiles = async (files: string[]) => {
    for (const file of files) {
      const next = await readJsonRecord(file);
      if (next) config = mergeRecords(config, next);
    }
  };

  await mergeFiles(configFiles(globalConfigDirectory(home), true));

  const explicitFile = nonEmptyEnv("OPENCODE_CONFIG");
  if (explicitFile) await mergeFiles([explicitFile]);

  const directories =
    cwd && !projectConfigDisabled() ? await projectDirectories(cwd) : [];
  for (const directory of directories.toReversed()) {
    await mergeFiles(configFiles(directory));
  }
  for (const directory of directories.toReversed()) {
    await mergeFiles(configFiles(path.join(directory, ".opencode")));
  }

  const customDirectory = nonEmptyEnv("OPENCODE_CONFIG_DIR");
  if (customDirectory) await mergeFiles(configFiles(customDirectory));

  const inline = nonEmptyEnv("OPENCODE_CONFIG_CONTENT");
  const inlineConfig = inline ? parseJsonRecord(inline) : null;
  return inlineConfig ? mergeRecords(config, inlineConfig) : config;
}

function authPaths(home: string): string[] {
  const explicitDataHome = nonEmptyEnv("XDG_DATA_HOME");
  const dataRoots = explicitDataHome
    ? [explicitDataHome]
    : uniquePaths([
        path.join(home, ".local", "share"),
        nonEmptyEnv("LOCALAPPDATA"),
        nonEmptyEnv("APPDATA"),
      ]);
  return dataRoots.map((root) => path.join(root, "opencode", "auth.json"));
}

export async function opencodeCredentialProviders(
  home: string,
): Promise<Set<string>> {
  const providers = new Set<string>();
  const collect = (record: Record<string, unknown> | null) => {
    if (!record) return;
    for (const [provider, credential] of Object.entries(record)) {
      if (!isRecord(credential)) continue;
      const valid =
        (credential.type === "api" &&
          typeof credential.key === "string" &&
          Boolean(credential.key.trim())) ||
        (credential.type === "oauth" &&
          typeof credential.refresh === "string" &&
          Boolean(credential.refresh.trim()) &&
          typeof credential.access === "string" &&
          Boolean(credential.access.trim())) ||
        (credential.type === "wellknown" &&
          typeof credential.key === "string" &&
          Boolean(credential.key.trim()) &&
          typeof credential.token === "string" &&
          Boolean(credential.token.trim()));
      if (valid) providers.add(provider);
    }
  };
  const inline = nonEmptyEnv("OPENCODE_AUTH_CONTENT");
  collect(inline ? parseJsonRecord(inline) : null);

  const authRecords = await Promise.all(authPaths(home).map(readJsonRecord));
  for (const record of authRecords) collect(record);
  return providers;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet)))
    return false;
  const values = octets.map(Number);
  if (values.some((value) => value > 255)) return false;
  return (
    values[0] === 0 ||
    values[0] === 10 ||
    values[0] === 127 ||
    (values[0] === 169 && values[1] === 254) ||
    (values[0] === 172 && values[1] >= 16 && values[1] <= 31) ||
    (values[0] === 192 && values[1] === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (hostname === "::1") return true;
  if (hostname.startsWith("::ffff:"))
    return isPrivateIpv4(hostname.slice("::ffff:".length));
  const firstGroup = Number.parseInt(hostname.split(":")[0] ?? "", 16);
  return (
    Number.isFinite(firstGroup) &&
    ((firstGroup & 0xfe00) === 0xfc00 || (firstGroup & 0xffc0) === 0xfe80)
  );
}

function isLocalNetworkUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const expanded = value.replace(
    /\{env:([^}]+)\}/g,
    (_match, name: string) => process.env[name]?.trim() ?? "",
  );
  try {
    const endpoint = new URL(expanded);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
      return false;
    const hostname = endpoint.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "host.docker.internal" ||
      hostname === "host.containers.internal" ||
      isPrivateIpv4(hostname) ||
      isPrivateIpv6(hostname)
    );
  } catch {
    return false;
  }
}

export function localProviderIds(config: Record<string, unknown>): Set<string> {
  const localProviders = new Set<string>();
  const providerMaps = [config.provider, config.providers].filter(isRecord);
  for (const providers of providerMaps) {
    for (const [providerId, provider] of Object.entries(providers)) {
      if (!isRecord(provider)) continue;
      const options = isRecord(provider.options) ? provider.options : null;
      const settings = isRecord(provider.settings) ? provider.settings : null;
      const local =
        isLocalNetworkUrl(options?.baseURL) ||
        isLocalNetworkUrl(options?.baseUrl) ||
        isLocalNetworkUrl(settings?.baseURL) ||
        isLocalNetworkUrl(settings?.baseUrl) ||
        isLocalNetworkUrl(provider.baseURL) ||
        isLocalNetworkUrl(provider.baseUrl);
      if (local) localProviders.add(providerId);
    }
  }
  return localProviders;
}

function providerRecords(
  config: Record<string, unknown>,
  providerId: string,
): Record<string, unknown>[] {
  return [config.provider, config.providers]
    .filter(isRecord)
    .map((providers) => providers[providerId])
    .filter(isRecord);
}

function referencedEnvironmentKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return (
    value
      .trim()
      .match(/^\$?\{env:([^}]+)\}$/)?.[1]
      ?.trim() || null
  );
}

export function providerHasConfiguredCredential(
  config: Record<string, unknown>,
  providerId: string,
): boolean {
  const environmentKeys = new Set(
    OPENCODE_PROVIDER_ENVIRONMENT_KEYS[providerId] ?? [],
  );
  let hasLiteralApiKey = false;
  for (const provider of providerRecords(config, providerId)) {
    if (Array.isArray(provider.env)) {
      for (const candidate of provider.env) {
        if (typeof candidate === "string" && candidate.trim())
          environmentKeys.add(candidate.trim());
      }
    }
    const options = isRecord(provider.options) ? provider.options : null;
    const settings = isRecord(provider.settings) ? provider.settings : null;
    for (const apiKey of [options?.apiKey, settings?.apiKey, provider.apiKey]) {
      const referencedKey = referencedEnvironmentKey(apiKey);
      if (referencedKey) {
        environmentKeys.add(referencedKey);
      } else if (
        typeof apiKey === "string" &&
        Boolean(apiKey.trim()) &&
        !/^\$?\{(?:env|file):[^}]+\}$/.test(apiKey.trim())
      ) {
        hasLiteralApiKey = true;
      }
    }
  }
  return (
    hasLiteralApiKey ||
    [...environmentKeys].some((name) => Boolean(process.env[name]?.trim()))
  );
}

export function providerIdForModel(model: string): string | null {
  const normalized = model.trim();
  const separator = normalized.indexOf("/");
  return separator > 0 && separator < normalized.length - 1
    ? normalized.slice(0, separator)
    : null;
}

export interface OpencodeServiceVersionProbeResult {
  state: "not_running" | "compatible" | "version_skew" | "incompatible" | "unknown";
  cliVersion: string | null;
  serviceVersion: string | null;
}

export interface OpencodeServiceVersionProbeDependencies {
  run(args: string[]): Promise<string>;
}

let serviceProbeDependenciesForTests: OpencodeServiceVersionProbeDependencies | null = null;

export function setOpencodeServiceProbeDependenciesForTests(
  dependencies: OpencodeServiceVersionProbeDependencies | null,
): void {
  serviceProbeDependenciesForTests = dependencies;
}

function normalizeOpencodeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(
    /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/,
  )?.[1] ?? null;
}

function loopbackServiceUrl(value: string): URL | null {
  const candidate = value.match(/https?:\/\/[^\s]+/i)?.[0];
  if (!candidate) return null;
  try {
    const endpoint = new URL(candidate);
    const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
      return null;
    }
    return endpoint;
  } catch {
    return null;
  }
}

async function runOpencodeProbe(binaryPath: string, args: string[]): Promise<string> {
  const invocation = cliInvocation(binaryPath, args);
  const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
    windowsHide: true,
    timeout: SERVICE_PROBE_TIMEOUT_MS,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 64 * 1024,
  });
  return `${stdout}\n${stderr}`.trim();
}

export async function probeOpencodeServiceVersion(
  binaryPath: string,
  dependencies?: OpencodeServiceVersionProbeDependencies,
): Promise<OpencodeServiceVersionProbeResult> {
  const run = (dependencies ?? serviceProbeDependenciesForTests)?.run
    ?? ((args: string[]) => runOpencodeProbe(binaryPath, args));
  let cliVersion: string | null = null;
  try {
    cliVersion = normalizeOpencodeVersion(await run(["--version"]));
  } catch {
    return { state: "unknown", cliVersion: null, serviceVersion: null };
  }

  let serviceStatus: string;
  try {
    serviceStatus = await run(["service", "status"]);
  } catch {
    return { state: "unknown", cliVersion, serviceVersion: null };
  }
  if (/\bstopped\b/i.test(serviceStatus)) {
    return { state: "not_running", cliVersion, serviceVersion: null };
  }

  if (!loopbackServiceUrl(serviceStatus)) {
    return { state: "unknown", cliVersion, serviceVersion: null };
  }

  let healthOutput: string;
  try {
    // The resident service protects /api/health with per-service Basic auth.
    // `opencode2 api` supplies those credentials; direct fetch returns 401.
    // Checking `service status` first avoids starting a stopped service.
    healthOutput = await run(["api", "get", "/api/health"]);
  } catch {
    return { state: "incompatible", cliVersion, serviceVersion: null };
  }

  let health: unknown;
  try {
    health = JSON.parse(healthOutput);
  } catch {
    return { state: "incompatible", cliVersion, serviceVersion: null };
  }
  const serviceVersion = isRecord(health)
    ? normalizeOpencodeVersion(health.version)
    : null;
  if (!cliVersion || !serviceVersion) {
    return { state: "incompatible", cliVersion, serviceVersion };
  }
  return {
    state: cliVersion === serviceVersion ? "compatible" : "version_skew",
    cliVersion,
    serviceVersion,
  };
}
