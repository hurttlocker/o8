//! AI transport modules for o8's native voice surfaces (voice P4).
//! Currently the Gemini-direct "Ask" path; Anthropic is NEVER called here
//! (billing rule — only the Claude REPL spawn may reach Anthropic).

pub mod gemini_ask;
