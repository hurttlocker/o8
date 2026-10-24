// Imported before shared stores: diagnostics must never corrupt MCP stdout.
// This module is used only by the standalone stdio entry point.
console.log = console.error.bind(console);
console.info = console.error.bind(console);
