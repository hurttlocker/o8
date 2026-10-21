import { expect, it } from 'vitest';
import { assertGitHubRequestBudget, githubCredentialScope, observeGitHubRequestBudget } from './request-budget';

it('reserves interactive capacity, isolates installations and resources, and releases after reset', () => {
  const scope = githubCredentialScope('https://example.test', 1, 'fixture');
  observeGitHubRequestBudget(scope, 'core', new Response('', { headers: { 'x-ratelimit-remaining': '75', 'x-ratelimit-reset': '100' } }), 1000);
  expect(() => assertGitHubRequestBudget(scope, 'core', 'background', 1000)).toThrow('capacity');
  expect(() => assertGitHubRequestBudget(scope, 'core', 'interactive', 1000)).not.toThrow();
  expect(() => assertGitHubRequestBudget(scope, 'graphql', 'background', 1000)).not.toThrow();
  expect(() => assertGitHubRequestBudget(githubCredentialScope('https://example.test', 2, 'fixture'), 'core', 'background', 1000)).not.toThrow();
  expect(() => assertGitHubRequestBudget(scope, 'core', 'background', 101_000)).not.toThrow();
});
it('honors secondary retry headers across resources and falls back to bounded exponential waiting', () => {
  const scope = 'secondary-fixture';
  observeGitHubRequestBudget(scope, 'core', new Response('', { status: 429, headers: { 'retry-after': '90' } }), 1000);
  expect(() => assertGitHubRequestBudget(scope, 'graphql', 'interactive', 80_000)).toThrow('wait');
  expect(() => assertGitHubRequestBudget(scope, 'core', 'interactive', 92_000)).not.toThrow();
  observeGitHubRequestBudget(scope, 'core', new Response('', { status: 403 }), 92_000, true);
  expect(() => assertGitHubRequestBudget(scope, 'core', 'interactive', 180_000)).toThrow('wait');
  expect(() => assertGitHubRequestBudget(scope, 'core', 'interactive', 213_000)).not.toThrow();
});
it('does not let out-of-order successful responses increase a known window budget', () => {
  const response = (remaining: string) => new Response('', { headers: { 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': '100' } });
  observeGitHubRequestBudget('ordered', 'core', response('0'), 1000);
  observeGitHubRequestBudget('ordered', 'core', response('250'), 1001);
  expect(() => assertGitHubRequestBudget('ordered', 'core', 'interactive', 1002)).toThrow('wait');
});
it('uses a bounded wait when a primary quota refusal omits its reset header', () => {
  observeGitHubRequestBudget('missing-reset', 'core', new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), 1000);
  expect(() => assertGitHubRequestBudget('missing-reset', 'core', 'interactive', 1000)).toThrow('wait');
  expect(() => assertGitHubRequestBudget('missing-reset', 'core', 'interactive', 62_000)).not.toThrow();
});
