use std::fs;
use std::path::Path;

fn main() {
  // #932: tauri-plugin-mcp permissions are only registered when the
  // `dev-mcp-plugin` Cargo feature is on. Tauri's compile-time capability
  // resolver needs the permission identifier (`mcp:*`) to exist at build
  // time, so we materialize `capabilities/mcp.json` only when the feature
  // is active. Without the feature, the file is removed so the build
  // doesn't fail on an unknown permission.
  let cap_dir = Path::new("capabilities");
  let template = cap_dir.join("mcp.json.in");
  let target = cap_dir.join("mcp.json");
  let feature_on = std::env::var("CARGO_FEATURE_DEV_MCP_PLUGIN").is_ok();

  println!("cargo:rerun-if-changed={}", template.display());
  println!("cargo:rerun-if-env-changed=CARGO_FEATURE_DEV_MCP_PLUGIN");

  if feature_on {
    if template.exists() {
      let contents = fs::read_to_string(&template).expect("read capabilities/mcp.json.in");
      let should_write = fs::read_to_string(&target)
        .map(|existing| existing != contents)
        .unwrap_or(true);

      if should_write {
        let _ = fs::write(&target, contents);
      }
    }
  } else if target.exists() {
    let _ = fs::remove_file(&target);
  }

  tauri_build::build()
}
