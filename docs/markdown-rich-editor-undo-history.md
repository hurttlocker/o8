# Rich Markdown undo history

Rich-mode undo history survives a Rich → Source → Rich round trip when the
Markdown source remains byte-identical. Source mode hides the existing
ProseMirror view instead of destroying it, so the same editor state and history
plugin resume when Rich mode returns.

Any Source-mode byte change is the preservation boundary. Arbitrary source
text edits cannot be mapped safely onto the prior ProseMirror transaction
history, so returning to Rich parses the changed source into a new editor state
with a new undo stack. Source mode shows this boundary before the switch back:
“Rich undo history will restart because Source mode changed the Markdown.”

Loading another file or explicitly reloading changed-on-disk content discards
the preserved Rich history because those actions replace the document. The
Rich editor size and unsupported-construct guards also discard preserved
history when they return the document to Source mode.
