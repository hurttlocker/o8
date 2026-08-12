import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getRuntimeCapability,
  listDeclarativeRuntimes,
  listDispatchableRuntimes,
} from "@/lib/orchestrator/runtime-capabilities";

const declarativeRuntimeIds = listDeclarativeRuntimes();

const authFixture = vi.hoisted(() => ({
  home: "",
  installed: new Set(["opencode2"]),
}));
const scanAndLinkMock = vi.hoisted(() =>
  vi.fn((binaryName: string) =>
    authFixture.installed.has(binaryName) ? `/test-bin/${binaryName}` : null,
  ),
);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => authFixture.home,
    },
  };
});

vi.mock("./cli-locate", () => ({
  scanAndLink: scanAndLinkMock,
}));

authFixture.home = mkdtempSync(path.join(os.tmpdir(), "o8-opencode-auth-"));
const routeFixture = mkdtempSync(path.join(os.tmpdir(), "o8-opencode-route-"));
const routeRepoPath = path.join(routeFixture, "repo");
execFileSync("git", ["init", "-q", routeRepoPath]);
process.env.O8_DATA_DIR = routeFixture;
process.env.CORTEX_IDE_DATA_DIR = routeFixture;

const {
  assertRuntimeDispatchable,
  getDispatchableRuntimeAvailability,
  getRuntimeAuthSnapshot,
  invalidateRuntimeAuthCache,
} = await import("./auth-detect");
const createMissionRoute =
  await import("@/app/api/orchestrator/create-mission/route");
const operatorDefaultsRoute =
  await import("@/app/api/panel/operator-defaults/route");

function createMissionRequest(
  model: string,
  issueNumber: number,
  repoPath = routeRepoPath,
): NextRequest {
  return new NextRequest(
    "http://localhost:3001/api/orchestrator/create-mission",
    {
      method: "POST",
      headers: { host: "localhost:3001" },
      body: JSON.stringify({
        clientMutationId: `create-opencode-${issueNumber}`,
        repoPath,
        requestedRuntime: "opencode",
        requestedModel: model,
        issues: [
          {
            number: issueNumber,
            title: `OpenCode ${model} readiness seam`,
            body: "Prove selected-provider readiness through mission creation.",
            url: "",
          },
        ],
      }),
    },
  );
}

beforeEach(() => {
  vi.stubEnv("XDG_CONFIG_HOME", path.join(authFixture.home, ".config"));
  vi.stubEnv("XDG_DATA_HOME", path.join(authFixture.home, ".local", "share"));
  vi.stubEnv("APPDATA", "");
  vi.stubEnv("LOCALAPPDATA", "");
  vi.stubEnv("OPENCODE_CONFIG_DIR", "");
  vi.stubEnv("OPENCODE_CONFIG", "");
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", "");
  vi.stubEnv("OPENCODE_AUTH_CONTENT", "");
  vi.stubEnv("OPENCODE_DISABLE_PROJECT_CONFIG", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("HOSTED_TEST_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  authFixture.installed = new Set(["opencode2"]);
  invalidateRuntimeAuthCache();
  rmSync(path.join(authFixture.home, ".config"), {
    recursive: true,
    force: true,
  });
  rmSync(path.join(authFixture.home, ".local"), {
    recursive: true,
    force: true,
  });
  rmSync(path.join(authFixture.home, "AppData"), {
    recursive: true,
    force: true,
  });
  rmSync(path.join(authFixture.home, "opencode-config"), {
    recursive: true,
    force: true,
  });
  rmSync(path.join(authFixture.home, "explicit-opencode.json"), {
    force: true,
  });
  rmSync(path.join(routeRepoPath, ".opencode"), {
    recursive: true,
    force: true,
  });
  rmSync(path.join(routeRepoPath, "nested"), { recursive: true, force: true });
  rmSync(path.join(routeRepoPath, "opencode.json"), { force: true });
  rmSync(path.join(routeRepoPath, "opencode.jsonc"), { force: true });
});

afterAll(() => {
  rmSync(authFixture.home, { recursive: true, force: true });
  rmSync(routeFixture, { recursive: true, force: true });
});

describe("OpenCode readiness preflight", () => {
  it("reports the trusted keyless default as ready without claiming authentication", async () => {
    invalidateRuntimeAuthCache();
    const snapshot = await getRuntimeAuthSnapshot();
    const status = snapshot.statuses.opencode;

    expect(status).toMatchObject({
      installed: true,
      ready: true,
      authenticated: false,
      runtime: "opencode",
      unavailableReason: null,
    });
    expect(status.detail).toContain("default model");
    expect(status.detail).toContain("keyless dispatch");
    expect(status.fix).toBe("No action needed.");

    const response = await operatorDefaultsRoute.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dispatchableRuntimes: expect.arrayContaining([
        expect.objectContaining({
          id: "opencode",
          available: true,
          unavailableReason: null,
        }),
      ]),
    });
  });

  it.each([
    { baseURL: "http://localhost:11434/v1", shape: "provider" },
    { baseURL: "http://192.168.50.12:11434/v1", shape: "providers" },
  ])(
    "allows only the selected keyless local provider through dispatch preflight: $baseURL",
    async ({ baseURL, shape }) => {
      const configPath = path.join(
        authFixture.home,
        ".config",
        "opencode",
        "opencode.jsonc",
      );
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        shape === "provider"
          ? `{
      // Keyless local providers are valid worker backends.
      "provider": {
        "local": {
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": ${JSON.stringify(baseURL)} },
          "models": { "coder": {} },
        },
        "hosted": {
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": "https://api.example.com/v1" },
          "models": { "coder": {} },
        },
      },
    }`
          : `{
      // OpenCode v2 uses providers + settings.
      "providers": {
        "local": {
          "package": "@opencode-ai/ai/providers/openai-compatible",
          "settings": { "baseURL": ${JSON.stringify(baseURL)} },
          "models": { "coder": {} },
        },
        "hosted": {
          "package": "@opencode-ai/ai/providers/openai-compatible",
          "settings": { "baseURL": "https://api.example.com/v1" },
          "models": { "coder": {} },
        },
      },
    }`,
      );
      invalidateRuntimeAuthCache();

      await expect(
        assertRuntimeDispatchable("opencode"),
      ).resolves.toBeUndefined();
      await expect(
        assertRuntimeDispatchable("opencode", "local/coder"),
      ).resolves.toBeUndefined();
      await expect(
        assertRuntimeDispatchable("opencode", "hosted/coder"),
      ).rejects.toMatchObject({
        code: "dispatch_cli_auth_unavailable",
        status: {
          ready: false,
          authenticated: false,
          unavailableReason: "needs_auth",
        },
      });
      await expect(
        assertRuntimeDispatchable("opencode", "coder"),
      ).rejects.toMatchObject({
        code: "dispatch_cli_auth_unavailable",
        status: { ready: false },
      });
      const snapshot = await getRuntimeAuthSnapshot();
      expect(snapshot.statuses.opencode).toMatchObject({
        installed: true,
        ready: true,
        authenticated: false,
        unavailableReason: null,
      });
      await expect(getDispatchableRuntimeAvailability()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "opencode",
            available: true,
            unavailableReason: null,
          }),
        ]),
      );
    },
    15_000,
  );

  it("keeps a hosted provider without credentials blocked at dispatch preflight", async () => {
    const configPath = path.join(
      authFixture.home,
      ".config",
      "opencode",
      "opencode.json",
    );
    const authPath = path.join(
      authFixture.home,
      ".local",
      "share",
      "opencode",
      "auth.json",
    );
    mkdirSync(path.dirname(configPath), { recursive: true });
    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          hosted: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://api.example.com/v1" },
            models: { coder: {} },
          },
        },
      }),
    );
    writeFileSync(authPath, "{}");
    invalidateRuntimeAuthCache();

    await expect(
      assertRuntimeDispatchable("opencode", "hosted/coder"),
    ).rejects.toMatchObject({
      code: "dispatch_cli_auth_unavailable",
      status: {
        runtime: "opencode",
        installed: true,
        ready: false,
        authenticated: false,
        unavailableReason: "needs_auth",
      },
    });
  });

  it("finds credential evidence in a portable AppData location", async () => {
    vi.stubEnv("XDG_DATA_HOME", "");
    const localAppData = path.join(authFixture.home, "AppData", "Local");
    vi.stubEnv("LOCALAPPDATA", localAppData);
    const authPath = path.join(localAppData, "opencode", "auth.json");
    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(
      authPath,
      JSON.stringify({ local: { type: "api", key: "test-key" } }),
    );
    invalidateRuntimeAuthCache();

    const snapshot = await getRuntimeAuthSnapshot();
    expect(snapshot.statuses.opencode).toMatchObject({
      ready: true,
      authenticated: true,
      unavailableReason: null,
    });
    await expect(
      assertRuntimeDispatchable("opencode", "local/coder"),
    ).resolves.toBeUndefined();
  });

  it("adds OPENCODE_CONFIG_DIR after the global config directory", async () => {
    const defaultConfigPath = path.join(
      authFixture.home,
      ".config",
      "opencode",
      "opencode.json",
    );
    mkdirSync(path.dirname(defaultConfigPath), { recursive: true });
    writeFileSync(
      defaultConfigPath,
      JSON.stringify({
        provider: {
          globalLocal: { options: { baseURL: "http://localhost:11434/v1" } },
        },
      }),
    );
    const configDir = path.join(authFixture.home, "opencode-config");
    vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
        provider: {
          customLocal: { options: { baseURL: "http://127.0.0.1:11434/v1" } },
        },
      }),
    );
    invalidateRuntimeAuthCache();

    await expect(
      assertRuntimeDispatchable("opencode", "globalLocal/coder"),
    ).resolves.toBeUndefined();
    await expect(
      assertRuntimeDispatchable("opencode", "customLocal/coder"),
    ).resolves.toBeUndefined();
    await expect(
      assertRuntimeDispatchable("opencode"),
    ).resolves.toBeUndefined();
  });

  it("follows OpenCode config precedence through explicit, project, directory, and inline sources", async () => {
    const providerConfig = (baseURL: string) =>
      JSON.stringify({
        provider: { layered: { options: { baseURL } } },
      });
    const globalConfigPath = path.join(
      authFixture.home,
      ".config",
      "opencode",
      "opencode.json",
    );
    const explicitConfigPath = path.join(
      authFixture.home,
      "explicit-opencode.json",
    );
    mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    writeFileSync(
      globalConfigPath,
      providerConfig("http://localhost:11434/v1"),
    );
    writeFileSync(
      explicitConfigPath,
      providerConfig("https://api.example.com/explicit"),
    );
    vi.stubEnv("OPENCODE_CONFIG", explicitConfigPath);
    invalidateRuntimeAuthCache();
    await expect(
      assertRuntimeDispatchable("opencode", "layered/coder", routeRepoPath),
    ).rejects.toMatchObject({
      code: "dispatch_cli_auth_unavailable",
    });

    writeFileSync(
      path.join(routeRepoPath, "opencode.json"),
      providerConfig("http://127.0.0.1:11434/v1"),
    );
    await expect(
      assertRuntimeDispatchable("opencode", "layered/coder", routeRepoPath),
    ).resolves.toBeUndefined();

    const projectDirectoryConfig = path.join(
      routeRepoPath,
      ".opencode",
      "opencode.json",
    );
    mkdirSync(path.dirname(projectDirectoryConfig), { recursive: true });
    writeFileSync(
      projectDirectoryConfig,
      providerConfig("https://api.example.com/project-directory"),
    );
    await expect(
      assertRuntimeDispatchable("opencode", "layered/coder", routeRepoPath),
    ).rejects.toMatchObject({
      code: "dispatch_cli_auth_unavailable",
    });

    const customDirectory = path.join(authFixture.home, "opencode-config");
    vi.stubEnv("OPENCODE_CONFIG_DIR", customDirectory);
    mkdirSync(customDirectory, { recursive: true });
    writeFileSync(
      path.join(customDirectory, "opencode.json"),
      providerConfig("http://localhost:11434/v1"),
    );
    await expect(
      assertRuntimeDispatchable("opencode", "layered/coder", routeRepoPath),
    ).resolves.toBeUndefined();

    vi.stubEnv(
      "OPENCODE_CONFIG_CONTENT",
      providerConfig("https://api.example.com/inline"),
    );
    await expect(
      assertRuntimeDispatchable("opencode", "layered/coder", routeRepoPath),
    ).rejects.toMatchObject({
      code: "dispatch_cli_auth_unavailable",
    });
  });

  it("blocks a global local provider when the repository config overrides it with a hosted endpoint", async () => {
    const globalConfigPath = path.join(
      authFixture.home,
      ".config",
      "opencode",
      "opencode.json",
    );
    const projectConfigPath = path.join(
      routeRepoPath,
      ".opencode",
      "opencode.json",
    );
    const authPath = path.join(
      authFixture.home,
      ".local",
      "share",
      "opencode",
      "auth.json",
    );
    mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        provider: {
          local: { options: { baseURL: "http://localhost:11434/v1" } },
        },
      }),
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        provider: {
          local: { options: { baseURL: "https://api.example.com/v1" } },
        },
      }),
    );
    writeFileSync(authPath, JSON.stringify({ local: {} }));
    invalidateRuntimeAuthCache();

    const response = await createMissionRoute.POST(
      createMissionRequest("local/coder", 91_761_003),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "dispatch_cli_auth_unavailable" },
    });
  });

  it("merges nested .opencode directories from the repository root toward the dispatch cwd", async () => {
    const nestedRepoPath = path.join(routeRepoPath, "nested", "workspace");
    const rootConfigPath = path.join(
      routeRepoPath,
      ".opencode",
      "opencode.json",
    );
    const nestedConfigPath = path.join(
      nestedRepoPath,
      ".opencode",
      "opencode.jsonc",
    );
    mkdirSync(path.dirname(rootConfigPath), { recursive: true });
    mkdirSync(path.dirname(nestedConfigPath), { recursive: true });
    writeFileSync(
      rootConfigPath,
      JSON.stringify({
        provider: {
          scoped: { options: { baseURL: "https://api.example.com/v1" } },
        },
      }),
    );
    writeFileSync(
      nestedConfigPath,
      `{
      // The closest project config wins.
      "provider": { "scoped": { "options": { "baseURL": "http://localhost:11434/v1" } } },
    }`,
    );
    invalidateRuntimeAuthCache();

    const response = await createMissionRoute.POST(
      createMissionRequest("scoped/coder", 91_761_009, nestedRepoPath),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("accepts the known zero-setup OpenCode model through the real create-mission route", async () => {
    invalidateRuntimeAuthCache();

    const response = await createMissionRoute.POST(
      createMissionRequest("opencode/deepseek-v4-flash-free", 91_761_004),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("uses inherited and configured provider env credentials without exposing their values", async () => {
    const configPath = path.join(
      authFixture.home,
      ".config",
      "opencode",
      "opencode.json",
    );
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          hosted: {
            options: {
              baseURL: "https://api.example.com/v1",
              apiKey: "{env:HOSTED_TEST_API_KEY}",
            },
          },
          configured: {
            options: {
              baseURL: "https://api.example.com/v1",
              apiKey: "fixture-configured-credential",
            },
          },
        },
      }),
    );
    vi.stubEnv("OPENROUTER_API_KEY", "fixture-openrouter-credential");
    vi.stubEnv("HOSTED_TEST_API_KEY", "fixture-hosted-credential");
    invalidateRuntimeAuthCache();

    const openrouterResponse = await createMissionRoute.POST(
      createMissionRequest("openrouter/test-model", 91_761_005),
    );
    expect(openrouterResponse.status).toBe(201);
    const hostedResponse = await createMissionRoute.POST(
      createMissionRequest("hosted/coder", 91_761_006),
    );
    expect(hostedResponse.status).toBe(201);
    const configuredResponse = await createMissionRoute.POST(
      createMissionRequest("configured/coder", 91_761_010),
    );
    expect(configuredResponse.status).toBe(201);

    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("HOSTED_TEST_API_KEY", "");
    invalidateRuntimeAuthCache();
    const missingOpenrouterResponse = await createMissionRoute.POST(
      createMissionRequest("openrouter/test-model", 91_761_007),
    );
    expect(missingOpenrouterResponse.status).toBe(400);
    const missingHostedResponse = await createMissionRoute.POST(
      createMissionRequest("hosted/coder", 91_761_008),
    );
    expect(missingHostedResponse.status).toBe(400);
    const payload = await missingHostedResponse.json();
    expect(JSON.stringify(payload)).not.toContain("fixture-hosted-credential");
  });

  it.each([
    {
      provider: "anthropic",
      environmentKey: "ANTHROPIC_API_KEY",
      issueNumber: 91_761_011,
    },
    {
      provider: "openai",
      environmentKey: "OPENAI_API_KEY",
      issueNumber: 91_761_012,
    },
    {
      provider: "zhipuai",
      environmentKey: "ZHIPU_API_KEY",
      issueNumber: 91_761_014,
    },
  ])(
    "accepts the standard $provider environment connection through the real create-mission route",
    async ({ provider, environmentKey, issueNumber }) => {
      const credential = `fixture-${provider}-credential`;
      vi.stubEnv(environmentKey, credential);
      invalidateRuntimeAuthCache();

      const response = await createMissionRoute.POST(
        createMissionRequest(`${provider}/test-model`, issueNumber),
      );
      expect(response.status).toBe(201);
      const payload = await response.json();
      expect(payload).toMatchObject({ ok: true });
      expect(JSON.stringify(payload)).not.toContain(credential);
    },
  );

  it("does not infer credential variable names for unknown providers", async () => {
    vi.stubEnv("UNKNOWN_PROVIDER_API_KEY", "fixture-unrelated-credential");
    invalidateRuntimeAuthCache();

    const response = await createMissionRoute.POST(
      createMissionRequest("unknown-provider/test-model", 91_761_013),
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: false });
    expect(JSON.stringify(payload)).not.toContain(
      "fixture-unrelated-credential",
    );
  });

  it("enforces mixed local and hosted providers through the real create-mission route", async () => {
    const configPath = path.join(
      authFixture.home,
      ".config",
      "opencode",
      "opencode.json",
    );
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          local: {
            options: { baseURL: "http://127.0.0.1:11434/v1" },
            models: { coder: {} },
          },
          hosted: {
            options: { baseURL: "https://api.example.com/v1" },
            models: { coder: {} },
          },
        },
      }),
    );
    invalidateRuntimeAuthCache();

    const localResponse = await createMissionRoute.POST(
      createMissionRequest("local/coder", 91_761_001),
    );
    expect(localResponse.status).toBe(201);
    expect(await localResponse.json()).toMatchObject({ ok: true });

    const hostedResponse = await createMissionRoute.POST(
      createMissionRequest("hosted/coder", 91_761_002),
    );
    expect(hostedResponse.status).toBe(400);
    const hostedPayload = await hostedResponse.json();
    expect(hostedPayload).toMatchObject({
      ok: false,
      error: {
        code: "dispatch_cli_auth_unavailable",
      },
    });
    expect(hostedPayload.error.message).toContain(
      'provider "hosted" has no credential evidence',
    );
  });
});

describe("dispatchable runtime readiness", () => {
  it("marks every declarative worker available when its PATH and credential probes pass", async () => {
    authFixture.installed = new Set([
      "opencode2",
      ...declarativeRuntimeIds.map(
        (runtime) => getRuntimeCapability(runtime).binaryName,
      ),
    ]);
    for (const runtime of declarativeRuntimeIds) {
      const declarative = getRuntimeCapability(runtime).declarative;
      const envName = declarative?.authEnvVars[0];
      if (envName) {
        vi.stubEnv(envName, `test-${runtime}`);
        continue;
      }
      // Env-less runtimes (qoder) authenticate by credential file only —
      // materialize the declared authPath in the fixture home instead of
      // inventing an env var the real CLI would ignore.
      const authPath = declarative?.authPaths[0];
      if (!authPath) throw new Error(`missing auth probe for ${runtime}`);
      const target = path.join(authFixture.home, authPath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "{}");
    }
    invalidateRuntimeAuthCache();

    const inventory = await getDispatchableRuntimeAvailability();
    for (const runtime of declarativeRuntimeIds) {
      expect(inventory.find((entry) => entry.id === runtime)).toMatchObject({
        available: true,
        unavailableReason: null,
      });
    }
  });

  it.each(declarativeRuntimeIds)(
    "returns a structured not-installed reason for %s when its PATH probe misses",
    async (runtime) => {
      authFixture.installed.delete(getRuntimeCapability(runtime).binaryName);
      invalidateRuntimeAuthCache();

      await expect(assertRuntimeDispatchable(runtime)).rejects.toMatchObject({
        code: "dispatch_cli_auth_unavailable",
        status: {
          runtime,
          installed: false,
          unavailableReason: "not_installed",
        },
      });
    },
  );

  it("returns a structured not-installed reason for a registered Pi adapter", async () => {
    vi.stubEnv("O8_PI_BIN", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    invalidateRuntimeAuthCache();

    await expect(assertRuntimeDispatchable("pi")).rejects.toMatchObject({
      code: "dispatch_cli_auth_unavailable",
      status: {
        runtime: "pi",
        installed: false,
        unavailableReason: "not_installed",
      },
    });
  });

  it("publishes every launch-capable adapter with availability truth", async () => {
    const inventory = await getDispatchableRuntimeAvailability();
    expect(inventory.map((entry) => entry.id)).toEqual(
      listDispatchableRuntimes(),
    );
    expect(inventory.every((entry) => entry.label.length > 0)).toBe(true);
    expect(inventory.find((entry) => entry.id === "pi")).toMatchObject({
      available: false,
      unavailableReason: "not_installed",
    });
  });
});
