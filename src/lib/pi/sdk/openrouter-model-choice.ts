/**
 * The explicit OpenRouter model choice for Pi (#3584), kept free of the Pi SDK
 * so registries and startup paths can recognize it without loading the SDK.
 */

export const OPENROUTER_PI_MODEL_PREFIX = 'openrouter/';

export function isOpenRouterPiModelChoice(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(OPENROUTER_PI_MODEL_PREFIX) && value.length > OPENROUTER_PI_MODEL_PREFIX.length;
}
