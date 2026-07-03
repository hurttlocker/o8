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
 * may still override with their own mkdtemp dirs — that stays safe because
 * both paths are temp dirs, never ~/.o8.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.O8_TEST_DATA_DIR_PINNED) {
  const dir = mkdtempSync(join(tmpdir(), 'o8-test-data-'));
  process.env.CORTEX_IDE_DATA_DIR = dir;
  process.env.O8_DATA_DIR = dir;
  process.env.O8_TEST_DATA_DIR_PINNED = dir;
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
