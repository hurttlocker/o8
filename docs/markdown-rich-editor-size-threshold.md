# Rich Markdown size threshold

Markdown files whose UTF-8 size is **greater than** `RICH_MARKDOWN_MAX_SOURCE_BYTES`
(`64 * 1024` = 65536 bytes) open in **source** mode only.

The constant and byte-length helper live in
`src/lib/markdown/editor/size-guard.ts`. Size is `TextEncoder#encode(source).byteLength`,
not JavaScript string length, so a file that is 65536 code units but 65537 UTF-8
bytes is still over the limit.

- Just at or under 65536 UTF-8 bytes: existing rich-mode path (operator can open Rich).
- Over 65536 UTF-8 bytes: source-only; the mode control explains that rich mode is
  unavailable because of file size. ProseMirror is not initialized.

This guard is independent of unsupported-construct handling.
