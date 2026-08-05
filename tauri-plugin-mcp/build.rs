const COMMANDS: &[&str] = &["mcp_result"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
