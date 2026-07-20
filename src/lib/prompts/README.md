# Programmatic prompts

Programmatic LLM prompts live in explicit version directories. Callers import a version such as `@/lib/prompts/v1`; prompt experiments create a sibling version instead of mutating an unrelated call site.

Keep stable system instructions and other cacheable prefixes byte-stable within a version. Put per-request artifacts in builder arguments so dynamic content stays after the stable prefix.

The native Symon system prompt is a text asset in the same version directory. Rust includes it at compile time and collapses its formatting whitespace, so editing the source does not add runtime filesystem access.
