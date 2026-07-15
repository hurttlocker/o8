// Keep in sync with src/lib/models.ts.

pub const CLAUDE_OPUS_4_8: &str = "claude-opus-4-8";
pub const CLAUDE_SONNET_5: &str = "claude-sonnet-5";
pub const GEMINI_3_FLASH_PREVIEW: &str = "gemini-3-flash-preview";
// Dictation polish default — A/B 2026-07-07: 426-467ms vs 5.8-6.6s (and cleaner
// corrections) than 3-flash-preview/2.5-flash on the polish task.
pub const GEMINI_2_5_FLASH_LITE: &str = "gemini-2.5-flash-lite";

pub const AGENT_MAC_NATIVE_ACTION_DEFAULT: &str = CLAUDE_SONNET_5;
pub const AGENT_INTENT_CLASSIFICATION_DEFAULT: &str = GEMINI_3_FLASH_PREVIEW;
pub const AGENT_RESULT_SUMMARIZATION_DEFAULT: &str = GEMINI_3_FLASH_PREVIEW;
pub const CLAUDE_BRAIN_MODEL: &str = CLAUDE_OPUS_4_8;
