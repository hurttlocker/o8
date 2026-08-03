import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  O8_BENCH_CLI_OVERRIDE_ENV,
  o8CliPreflightSummary,
  preflightO8Cli,
} from '../../scripts/bench/coding-o8-cli';

function writeFakeCli(filePath: string, supportsExistingBranchPolicy = true): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    '#!/bin/sh\n' +
    `printf '%s\\n' '${supportsExistingBranchPolicy ? '--existingBranchPolicy' : '--compare'}'\n`,
  );
  fs.chmodSync(filePath, 0o755);
}

describe('coding benchmark o8 CLI resolution', () => {
  it('prefers an explicit override over the repo CLI and PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-cli-override-'));
    try {
      const overrideCli = path.join(root, 'override', 'o8');
      writeFakeCli(overrideCli);
      writeFakeCli(path.join(root, 'cli', 'dist', 'o8.mjs'));
      writeFakeCli(path.join(root, 'path-bin', 'o8'));

      const receipt = preflightO8Cli(root, {
        ...process.env,
        PATH: path.join(root, 'path-bin'),
        [O8_BENCH_CLI_OVERRIDE_ENV]: overrideCli,
      });

      expect(receipt).toMatchObject({
        resolvedPath: fs.realpathSync(overrideCli),
        source: 'override',
        repoCliExists: true,
        capabilities: { existingBranchPolicy: true },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the repo CLI and records a PATH fallback when the repo build is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-cli-source-'));
    try {
      const repoCli = path.join(root, 'cli', 'dist', 'o8.mjs');
      const pathCli = path.join(root, 'path-bin', 'o8');
      writeFakeCli(repoCli);
      writeFakeCli(pathCli);

      const fromRepo = preflightO8Cli(root, { ...process.env, PATH: path.dirname(pathCli) });
      expect(fromRepo).toMatchObject({
        resolvedPath: fs.realpathSync(repoCli),
        source: 'repo',
        repoCliExists: true,
      });

      fs.unlinkSync(repoCli);
      const fromPath = preflightO8Cli(root, { ...process.env, PATH: path.dirname(pathCli) });
      expect(fromPath).toMatchObject({
        resolvedPath: fs.realpathSync(pathCli),
        source: 'path',
        repoCliExists: false,
      });
      expect(o8CliPreflightSummary(fromPath)).toContain(`repo CLI missing at ${repoCli}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails preflight when the resolved CLI lacks the governed branch-policy capability', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-cli-capability-'));
    try {
      const repoCli = path.join(root, 'cli', 'dist', 'o8.mjs');
      writeFakeCli(repoCli, false);

      expect(() => preflightO8Cli(root, { ...process.env, PATH: '' })).toThrow(
        /lacks the required mission create --existingBranchPolicy capability; run npm run build:cli/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
