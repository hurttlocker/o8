/**
 * Global test isolation — the production-data-dir leak fix (2026-07-03).
 *
 * Vitest runs many test files per worker process, and the app's data-dir
 * consumers (getDb(), mission store, operator defaults) memoize on FIRST
 * touch. A test file that set CORTEX_IDE_DATA_DIR at its own module top was
 * only safe if no earlier file in the same worker had already pinned the
 * singleton to the real ~/.o8 — test-order roulette. The observed failure:
 * mission-service tests wrote REAL missions into the operator's production
 * DB on every `npm test`, replacing the current mission and getting live
 * worker lanes interrupted/archived (wave-1 assassination, 2026-07-03).
 *
 * This setup file runs before each test file's imports in every worker, so
 * the env is hermetic before ANY app module can initialize. Individual tests
 * may still override CORTEX_IDE_DATA_DIR with their own mkdtemp dirs. Keep
 * O8_DATA_DIR unset here so the canonical resolver's modern-name precedence
 * cannot shadow those per-test overrides.
 */
type FsModule = typeof import('node:fs');
type OsModule = typeof import('node:os');
type PathModule = typeof import('node:path');

const getBuiltinModule = (process as NodeJS.Process & {
  getBuiltinModule?: (id: string) => unknown;
}).getBuiltinModule;

const fs = getBuiltinModule?.('node:fs') as FsModule | undefined;
const os = getBuiltinModule?.('node:os') as OsModule | undefined;
const path = getBuiltinModule?.('node:path') as PathModule | undefined;

if (!fs || !os || !path) {
  throw new Error('Vitest setup requires Node built-in modules.');
}

if (!process.env.O8_TEST_DATA_DIR_PINNED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-test-data-'));
  delete process.env.O8_DATA_DIR;
  process.env.CORTEX_IDE_DATA_DIR = dir;
  process.env.O8_TEST_DATA_DIR_PINNED = dir;

  // Layer 3 — sever the OWNED-RUNTIME-ROOT leak (#1585, 2026-07-18).
  // The canonical root defaults now follow the data-dir redirect above. Keep
  // the dedicated owned-root variables pinned too as defense in depth: a test
  // that overrides one adapter's resolution must still never see, let alone
  // signal, a real session. Keep this list in sync with each adapter's
  // rootEnvVar.
  const ownedRootEnvVars = [
    'CORTEX_IDE_OWNED_CODEX_ROOT',
    'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
    'O8_OWNED_GEMINI_ROOT',
    'O8_OWNED_OPENCODE_ROOT',
    'O8_OWNED_CURSOR_ROOT',
    'O8_OWNED_GROK_ROOT',
    'O8_OWNED_PI_ROOT',
  ];
  for (const envVar of ownedRootEnvVars) {
    process.env[envVar] = path.join(dir, envVar.toLowerCase());
  }
}

// Layer 2 — sever the live-server escape hatch: any code path that resolves
// the app's API base via O8_API_PORT would otherwise reach a RUNNING prod app
// on this machine over HTTP and mutate real state (the +1 lane leak, same
// night). Point it at a dead port; tests that exercise routes import the
// handlers directly and never notice.
if (!process.env.O8_TEST_API_PORT_PINNED) {
  process.env.O8_API_PORT = '59998';
  process.env.O8_TEST_API_PORT_PINNED = '1';
}
