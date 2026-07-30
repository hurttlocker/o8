import assert from 'node:assert/strict';

import {
  MANAGED_ASK_MAX_TOKENS,
  applyInferencePlanPolicy,
  managedAskModels,
  sanitizeManagedAskRequest,
  shouldTryNextManagedAskModel,
} from '../src/ask-policy.js';

const textRequest = sanitizeManagedAskRequest({
  model: 'vendor/expensive-model',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
  max_tokens: 99_999,
});
assert.equal(textRequest.ok, true);
assert.deepEqual(managedAskModels(false), [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-120b:free',
  'openrouter/free',
]);

const imageRequest = sanitizeManagedAskRequest({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is this?' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' },
      },
    ],
  }],
});
assert.equal(imageRequest.ok && imageRequest.request.hasImages, true);
assert.deepEqual(managedAskModels(true), ['openrouter/free']);

assert.equal(
  sanitizeManagedAskRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
    }],
  }).ok,
  false,
);

const freeBody = applyInferencePlanPolicy('free', {
  model: 'vendor/expensive-model',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 99_999,
});
assert.equal(freeBody.model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
assert.equal(freeBody.max_tokens, MANAGED_ASK_MAX_TOKENS);

const founderBody = { model: 'google/gemini-3-flash-preview' };
assert.equal(applyInferencePlanPolicy('founder', founderBody), founderBody);
assert.equal(shouldTryNextManagedAskModel(429), true);
assert.equal(shouldTryNextManagedAskModel(503), true);
assert.equal(shouldTryNextManagedAskModel(400), false);

console.log('ask policy tests passed');
