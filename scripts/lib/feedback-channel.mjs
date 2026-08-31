import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHANNEL_ID = /^\d{17,20}$/;

function validate(value, source) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) return null;
  if (!CHANNEL_ID.test(id)) {
    throw new Error(`${source} must be a numeric channel id.`);
  }
  return id;
}

/**
 * Resolve the non-secret private-intake channel identity used by maintainer
 * reconciliation scripts. There is deliberately no baked legacy fallback: a
 * server move must update explicit configuration instead of silently reading
 * or writing the retired channel.
 */
export function resolveFeedbackChannelId({ env = process.env, root = process.cwd() } = {}) {
  const fromEnv = validate(env.O8_FEEDBACK_CHANNEL_ID, 'O8_FEEDBACK_CHANNEL_ID');
  if (fromEnv) return fromEnv;

  try {
    const parsed = JSON.parse(readFileSync(join(root, 'o8.release.json'), 'utf8'));
    return validate(parsed?.feedbackChannelId, 'o8.release.json feedbackChannelId');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error('o8.release.json is not valid JSON.');
    }
    throw error;
  }
}

export function requireFeedbackChannelId(options = {}) {
  const id = resolveFeedbackChannelId(options);
  if (id) return id;
  throw new Error(
    'Private intake channel is not configured. Set O8_FEEDBACK_CHANNEL_ID or feedbackChannelId in o8.release.json.',
  );
}
