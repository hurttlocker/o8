//! Native ACL regression table recorded before the context-codegen patch.
//! Run with --features tauri/custom-protocol,dev-mcp-plugin on macOS.
#![cfg(all(target_os = "macos", feature = "dev-mcp-plugin"))]

include!("acl_table.rs.inc");

#[test]
fn generated_context_preserves_all_fixed_acl_decisions() {
    let table: Value = serde_json::from_str(include_str!("fixtures/acl-decisions.json")).unwrap();
    let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let actual = decision_digest(context.runtime_authority_mut(), &table);
    assert_eq!(
        actual.1, 133_588,
        "fixed command/window/webview/origin table"
    );
    assert_eq!(actual.2, 25_396, "baseline allowed decisions");
    assert_eq!(
        actual.0, "b1b2e68da8b0853ec06dfd0d0a5c72835e40cbe92012d69f06f403d754122044",
        "ACL decisions changed from the unpatched runtime authority baseline"
    );
}

#[test]
fn fixed_table_covers_current_manifest_commands_and_capability_windows() {
    use std::collections::BTreeSet;
    let table: Value = serde_json::from_str(include_str!("fixtures/acl-decisions.json")).unwrap();
    let manifests: Value =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let capabilities: Value =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    let mut commands = BTreeSet::from(["unknown-command".to_string()]);
    for (plugin, manifest) in manifests.as_object().unwrap() {
        for permission in manifest["permissions"].as_object().unwrap().values() {
            for mode in ["allow", "deny"] {
                for command in permission["commands"][mode]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    let command = command.as_str().unwrap();
                    commands.insert(if plugin == "__app-acl__" {
                        command.into()
                    } else {
                        format!(
                            "plugin:{}|{command}",
                            plugin.strip_prefix("core:").unwrap_or(plugin)
                        )
                    });
                }
            }
        }
    }
    let fixed_commands: BTreeSet<String> = table["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().into())
        .collect();
    assert_eq!(
        commands, fixed_commands,
        "recapture parity explicitly when the command manifest changes"
    );
    let ids: Vec<_> = capabilities.as_object().unwrap().keys().cloned().collect();
    assert_eq!(serde_json::to_value(ids).unwrap(), table["capabilities"]);
    for capability in capabilities.as_object().unwrap().values() {
        for window in capability["windows"].as_array().into_iter().flatten() {
            if window != "*" {
                assert!(
                    table["windowWebview"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|pair| pair[0] == *window),
                    "capability window absent from parity table: {window}"
                );
            }
        }
    }
}
