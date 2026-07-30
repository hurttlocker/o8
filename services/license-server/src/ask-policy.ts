import type { Plan } from './mint.js';

export const MANAGED_ASK_TEXT_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-120b:free',
  'openrouter/free',
] as const;

export const MANAGED_ASK_VISION_MODELS = [
  'openrouter/free',
] as const;

export const MANAGED_ASK_MAX_TOKENS = 4_096;
export const MANAGED_ASK_MAX_BODY_BYTES = 8 * 1024 * 1024;

type AskTextPart = { type: 'text'; text: string };
type AskImagePart = {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
};

export type ManagedAskMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<AskTextPart | AskImagePart>;
};

export type ManagedAskRequest = {
  messages: ManagedAskMessage[];
  stream: boolean;
  hasImages: boolean;
};

export type AskPolicyResult =
  | { ok: true; request: ManagedAskRequest }
  | { ok: false; error: string };

const MAX_MESSAGES = 20;
const MAX_PARTS_PER_MESSAGE = 8;
const MAX_IMAGES = 4;
const MAX_TEXT_CHARACTERS = 256_000;
const MAX_IMAGE_URL_CHARACTERS = 7_000_000;
const MAX_TOTAL_IMAGE_CHARACTERS = 7_000_000;
const DATA_IMAGE_URL =
  /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[a-z0-9+/=\r\n]+$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sanitizeManagedAskRequest(value: unknown): AskPolicyResult {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return { ok: false, error: 'messages array is required' };
  }
  if (value.messages.length === 0 || value.messages.length > MAX_MESSAGES) {
    return { ok: false, error: `messages must contain 1-${MAX_MESSAGES} items` };
  }

  let textCharacters = 0;
  let imageCharacters = 0;
  let imageCount = 0;
  let hasImages = false;
  const messages: ManagedAskMessage[] = [];

  for (const rawMessage of value.messages) {
    if (!isRecord(rawMessage)) {
      return { ok: false, error: 'each message must be an object' };
    }
    const role = rawMessage.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { ok: false, error: 'message role must be system, user, or assistant' };
    }

    if (typeof rawMessage.content === 'string') {
      textCharacters += rawMessage.content.length;
      messages.push({ role, content: rawMessage.content });
      continue;
    }
    if (
      !Array.isArray(rawMessage.content)
      || rawMessage.content.length === 0
      || rawMessage.content.length > MAX_PARTS_PER_MESSAGE
    ) {
      return { ok: false, error: 'message content must be text or typed parts' };
    }

    const parts: Array<AskTextPart | AskImagePart> = [];
    for (const rawPart of rawMessage.content) {
      if (!isRecord(rawPart)) {
        return { ok: false, error: 'message parts must be objects' };
      }
      if (rawPart.type === 'text' && typeof rawPart.text === 'string') {
        textCharacters += rawPart.text.length;
        parts.push({ type: 'text', text: rawPart.text });
        continue;
      }
      if (rawPart.type === 'image_url' && isRecord(rawPart.image_url)) {
        const url = rawPart.image_url.url;
        const detail = rawPart.image_url.detail;
        if (
          typeof url !== 'string'
          || url.length > MAX_IMAGE_URL_CHARACTERS
          || !DATA_IMAGE_URL.test(url)
        ) {
          return { ok: false, error: 'image parts must contain a supported data image URL' };
        }
        if (
          detail !== undefined
          && detail !== 'auto'
          && detail !== 'low'
          && detail !== 'high'
        ) {
          return { ok: false, error: 'image detail must be auto, low, or high' };
        }
        imageCharacters += url.length;
        imageCount += 1;
        hasImages = true;
        parts.push({
          type: 'image_url',
          image_url: { url, ...(detail ? { detail } : {}) },
        });
        continue;
      }
      return { ok: false, error: 'unsupported message part' };
    }
    messages.push({ role, content: parts });
  }

  if (textCharacters > MAX_TEXT_CHARACTERS) {
    return { ok: false, error: 'message text is too large' };
  }
  if (imageCharacters > MAX_TOTAL_IMAGE_CHARACTERS) {
    return { ok: false, error: 'attached images are too large' };
  }
  if (imageCount > MAX_IMAGES) {
    return { ok: false, error: `attach up to ${MAX_IMAGES} images at once` };
  }

  return {
    ok: true,
    request: {
      messages,
      stream: value.stream !== false,
      hasImages,
    },
  };
}

export function managedAskModels(hasImages: boolean): readonly string[] {
  return hasImages ? MANAGED_ASK_VISION_MODELS : MANAGED_ASK_TEXT_MODELS;
}

export function shouldTryNextManagedAskModel(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function applyInferencePlanPolicy(
  plan: Plan,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (plan !== 'free') return body;
  const parsed = sanitizeManagedAskRequest(body);
  const hasImages = parsed.ok && parsed.request.hasImages;
  const requestedMax =
    typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
      ? body.max_tokens
      : MANAGED_ASK_MAX_TOKENS;
  return {
    ...body,
    model: managedAskModels(hasImages)[0],
    max_tokens: Math.min(
      Math.max(1, Math.floor(requestedMax)),
      MANAGED_ASK_MAX_TOKENS,
    ),
  };
}
