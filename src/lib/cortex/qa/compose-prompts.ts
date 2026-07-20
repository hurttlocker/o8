// Compatibility surface for callers outside the Q&A pipeline. New code should
// import the explicit prompt version from `@/lib/prompts/v1`.
export {
  buildFlashComposePrompt,
  buildSonnetComposeSystem,
  buildSonnetComposeUser,
  type ComposeOptions,
} from '@/lib/prompts/v1';
