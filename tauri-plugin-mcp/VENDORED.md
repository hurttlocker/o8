# Vendored crate

This directory is a vendored fork of the upstream MIT-licensed
`tauri-plugin-mcp` crate (see `LICENSE` and the License section of the
upstream `README.md`; author attribution is preserved in `Cargo.toml`).
It powers o8's `dev-mcp-plugin` Cargo feature — the Unix-socket webview
control surface behind the `o8_view_*` operator tools.

What is vendored: `Cargo.toml`, `build.rs`, `src/`, `permissions/`, and the
upstream `README.md`. Not vendored: the upstream JS guest bindings
(`guest-js`/`dist-js`), the standalone Node MCP server (`mcp-server-ts`),
and their packaging files — o8's bundled operator MCP server speaks to the
plugin's socket directly, so none of that ships here.

Local modifications since the fork are tracked in this repository's history
from the vendoring commit forward. The upstream README's install
instructions describe the upstream npm distribution, not how o8 consumes
the plugin — see the root `CLAUDE.md` ("Webview control tools") for that.
