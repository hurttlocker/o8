import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveReleaseConfig } from '../scripts/lib/release-config.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(config: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-config-'));
  roots.push(root);
  writeFileSync(join(root, 'o8.release.json'), `${JSON.stringify(config)}\n`);
  return root;
}

describe('release config', () => {
  it('provides the Clerk key to the web build without exposing a secret contract', () => {
    const root = fixture({ clerkPublishableKey: 'pk_test_from_file' });
    expect(resolveReleaseConfig(root, {})).toMatchObject({
      clerkPublishableKey: 'pk_test_from_file',
    });
  });

  it('lets the build environment override file-backed public values', () => {
    const root = fixture({ clerkPublishableKey: 'pk_test_from_file' });
    expect(resolveReleaseConfig(root, {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_from_env',
    })).toMatchObject({
      clerkPublishableKey: 'pk_test_from_env',
    });
  });

  it('never resolves the retired feedback webhook into packaged build config', () => {
    const root = fixture({ feedbackWebhookUrl: 'https://private.test/webhook' });
    const config = resolveReleaseConfig(root, {
      O8_FEEDBACK_WEBHOOK_URL: 'https://private.test/env-webhook',
    });

    expect(config).not.toHaveProperty('feedbackWebhookUrl');
    expect(JSON.stringify(config)).not.toContain('private.test');
  });
});
