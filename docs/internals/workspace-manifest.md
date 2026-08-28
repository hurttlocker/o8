# Repository workspace manifest

`o8.workspace.json` is a versioned repository workspace declaration. Keep it at the repository root, next to `o8.md`, and check it into the repository so clones receive the same contract. `~/.o8/repos.json` can cache the manifest version, path, service names, or a validation error, but the checked-in file is the source of truth.

## Version 1 schema

```ts
interface WorkspaceManifestV1 {
  version: 1;
  setup?: string[];
  teardown?: string[];
  services?: Array<{
    name: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    port?: {
      preferred: number;
      env?: string;
    };
    health?: {
      http?: string;
      tcp?: true;
      timeoutMs?: number;
    };
  }>;
  preview?: {
    url: string;
  };
}
```

`setup` and `teardown` list commands that run from the repository root. A service `cwd`, when present, is relative to that root. `preview.url` can contain `{{port}}` or `{{service:<name>}}` placeholders.

## Complete example

```json
{
  "version": 1,
  "setup": [
    "npm install",
    "npm run build"
  ],
  "teardown": [
    "npm run cleanup"
  ],
  "services": [
    {
      "name": "api",
      "command": "npm run dev:api",
      "cwd": "apps/api",
      "env": {
        "LOG_LEVEL": "debug"
      },
      "port": {
        "preferred": 4100,
        "env": "PORT"
      },
      "health": {
        "http": "http://127.0.0.1:4100/health",
        "timeoutMs": 30000
      }
    },
    {
      "name": "web",
      "command": "npm run dev:web",
      "cwd": "apps/web",
      "port": {
        "preferred": 4173,
        "env": "PORT"
      },
      "health": {
        "tcp": true,
        "timeoutMs": 30000
      }
    }
  ],
  "preview": {
    "url": "http://127.0.0.1:{{service:web}}"
  }
}
```

## Validation and discovery rules

- Parsing is strict at every schema object. An unknown key fails validation and the error names its JSON path, such as `$.services[0].restart`.
- `version` is required. Version 1 passes through `migrateManifest()` unchanged. Unsupported versions fail with an error at `$.version`.
- Service names must be unique within one manifest.
- A preferred port must be an integer from 1 through 65535. It cannot use o8's current production, reserved, or development blocks: `47100` through `47111` and `47120` through `47129`. `src/lib/panel/port-constants.ts` is authoritative.
- `loadWorkspaceManifest(repoPath)` reads only `<repoPath>/o8.workspace.json`. A missing file returns `null`.
- Repository connection never fails because of an invalid manifest. The registry caches `{ manifest: { error } }` and leaves the checked-in file unchanged.
- Discovery does not run setup, teardown, services, health checks, placeholder resolution, or port allocation.

#1909 wires launch-time consumption of this declaration.
