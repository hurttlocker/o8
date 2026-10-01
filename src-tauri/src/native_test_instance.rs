use std::path::{Component, Path, PathBuf};

use crate::{PROD_API_PORT_RANGE, PROD_WS_PORT_RANGE};

const TEST_FLAG: &str = "O8_PRESHIP_GATE";
const DEV_FRONTEND_ENV: &str = "O8_DEV_FRONTEND_URL";
const CUSTOM_PROTOCOL_BUILD: bool = cfg!(o8_custom_protocol);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeTestInstance {
    pub(crate) api_port: u16,
    pub(crate) ws_port: u16,
}

impl NativeTestInstance {
    pub(crate) fn from_env_if_requested() -> Result<Option<Self>, String> {
        let get = |name: &str| std::env::var(name).ok();
        Self::from_values_if_requested(get, CUSTOM_PROTOCOL_BUILD)
    }

    fn from_values_if_requested(
        get: impl Fn(&str) -> Option<String>,
        custom_protocol_build: bool,
    ) -> Result<Option<Self>, String> {
        if !isolation_requested(&get) {
            return Ok(None);
        }
        if !custom_protocol_build {
            return Err(
                "isolated native tests require a custom-protocol binary; rebuild with `cargo tauri build`"
                    .into(),
            );
        }

        Self::validate(get).map(Some)
    }

    fn validate(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        if get(DEV_FRONTEND_ENV).is_some_and(|value| !value.trim().is_empty()) {
            return Err(format!(
                "{DEV_FRONTEND_ENV} is incompatible with an isolated native test instance"
            ));
        }
        require_one(&get, "O8_FORCE_BUNDLED_SERVERS")?;

        let data_dir = required_path(&get, "O8_DATA_DIR")?;
        let legacy_data_dir = required_path(&get, "CORTEX_IDE_DATA_DIR")?;
        if normalize(&data_dir) != normalize(&legacy_data_dir) {
            return Err(
                "O8_DATA_DIR and CORTEX_IDE_DATA_DIR must identify the same isolated directory"
                    .into(),
            );
        }
        if !data_dir.is_absolute() {
            return Err("O8_DATA_DIR must be absolute for a native test instance".into());
        }
        if !data_dir.is_dir() {
            return Err("O8_DATA_DIR must exist before a native test instance starts".into());
        }

        let production_data_dir = production_data_dir(&get)?;
        let isolated = canonical_or_normalized(&data_dir);
        let production = canonical_or_normalized(&production_data_dir);
        if isolated == production || isolated.starts_with(&production) {
            return Err(
                "native test data directory must be outside the production o8 data directory"
                    .into(),
            );
        }

        let api_port = required_port(&get, "O8_API_PORT")?;
        let ws_port = required_port(&get, "O8_WS_PORT")?;
        if api_port == ws_port {
            return Err("O8_API_PORT and O8_WS_PORT must be distinct".into());
        }
        if PROD_API_PORT_RANGE.contains(&api_port)
            || PROD_WS_PORT_RANGE.contains(&api_port)
            || PROD_API_PORT_RANGE.contains(&ws_port)
            || PROD_WS_PORT_RANGE.contains(&ws_port)
        {
            return Err("native test ports must be outside the production port ranges".into());
        }

        let mcp_socket = required_path(&get, "O8_TAURI_MCP_SOCKET")?;
        if !mcp_socket.is_absolute() {
            return Err("O8_TAURI_MCP_SOCKET must be absolute for a native test instance".into());
        }
        let default_socket = PathBuf::from(format!(
            "/tmp/tauri-mcp-o8-{}.sock",
            get("USER").unwrap_or_else(|| "default".into())
        ));
        if socket_path_identity(&mcp_socket) == socket_path_identity(&default_socket) {
            return Err("native test instance cannot use the production MCP socket".into());
        }
        let socket_parent = mcp_socket
            .parent()
            .ok_or_else(|| "O8_TAURI_MCP_SOCKET must have a parent directory".to_string())?;
        if !socket_parent.is_dir() {
            return Err("O8_TAURI_MCP_SOCKET parent directory must exist".into());
        }

        Ok(Self { api_port, ws_port })
    }
}

fn isolation_requested(get: &impl Fn(&str) -> Option<String>) -> bool {
    get(TEST_FLAG).as_deref() == Some("1")
        || (get(DEV_FRONTEND_ENV).is_some_and(|value| !value.trim().is_empty())
            && (get("O8_DATA_DIR").is_some_and(|value| !value.trim().is_empty())
                || get("CORTEX_IDE_DATA_DIR").is_some_and(|value| !value.trim().is_empty())))
}

fn require_one(get: &impl Fn(&str) -> Option<String>, name: &str) -> Result<(), String> {
    if get(name).as_deref() == Some("1") {
        Ok(())
    } else {
        Err(format!("{name}=1 is required for a native test instance"))
    }
}

fn required_path(get: &impl Fn(&str) -> Option<String>, name: &str) -> Result<PathBuf, String> {
    let value = get(name).filter(|value| !value.trim().is_empty());
    value
        .map(PathBuf::from)
        .ok_or_else(|| format!("{name} is required for a native test instance"))
}

fn required_port(get: &impl Fn(&str) -> Option<String>, name: &str) -> Result<u16, String> {
    get(name)
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .ok_or_else(|| format!("{name} must be a non-zero TCP port"))
}

fn production_data_dir(get: &impl Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    let home = get("HOME")
        .or_else(|| get("USERPROFILE"))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "HOME is required to validate native test isolation".to_string())?;
    Ok(PathBuf::from(home).join(".o8"))
}

fn canonical_or_normalized(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| normalize(path))
}

fn socket_path_identity(path: &Path) -> PathBuf {
    let Some(file_name) = path.file_name() else {
        return canonical_or_normalized(path);
    };
    path.parent()
        .map(canonical_or_normalized)
        .unwrap_or_default()
        .join(file_name)
}

fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TestRoot, HashMap<String, String>) {
        let root = TestRoot(std::env::temp_dir().join(format!(
            "o8-native-isolation-test-{}-{}",
            std::process::id(),
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        )));
        std::fs::create_dir_all(root.path()).unwrap();
        let home = root.path().join("home");
        let data = root.path().join("profile");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let values = HashMap::from([
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("USER".into(), "test-user".into()),
            (TEST_FLAG.into(), "1".into()),
            ("O8_FORCE_BUNDLED_SERVERS".into(), "1".into()),
            ("O8_DATA_DIR".into(), data.to_string_lossy().into_owned()),
            (
                "CORTEX_IDE_DATA_DIR".into(),
                data.to_string_lossy().into_owned(),
            ),
            ("O8_API_PORT".into(), "3060".into()),
            ("O8_WS_PORT".into(), "3061".into()),
            (
                "O8_TAURI_MCP_SOCKET".into(),
                root.path().join("test.sock").to_string_lossy().into_owned(),
            ),
        ]);
        (root, values)
    }

    fn validate(values: &HashMap<String, String>) -> Result<NativeTestInstance, String> {
        NativeTestInstance::validate(|name| values.get(name).cloned())
    }

    fn from_values(
        values: &HashMap<String, String>,
        custom_protocol_build: bool,
    ) -> Result<Option<NativeTestInstance>, String> {
        NativeTestInstance::from_values_if_requested(
            |name| values.get(name).cloned(),
            custom_protocol_build,
        )
    }

    #[test]
    fn accepts_complete_isolated_contract() {
        let (_root, values) = fixture();
        assert!(from_values(&values, true).unwrap().is_some());
    }

    #[test]
    fn rejects_complete_isolated_contract_without_custom_protocol() {
        let (_root, values) = fixture();
        let error = from_values(&values, false).unwrap_err();
        assert!(error.contains("cargo tauri build"));
    }

    #[test]
    fn ordinary_non_test_development_startup_remains_allowed() {
        let values = HashMap::new();
        assert_eq!(from_values(&values, false).unwrap(), None);
    }

    #[test]
    fn original_profile_plus_dev_frontend_launch_requests_isolation_and_is_rejected() {
        let (_root, mut values) = fixture();
        values.remove(TEST_FLAG);
        values.insert(DEV_FRONTEND_ENV.into(), "http://127.0.0.1:3060".into());
        let get = |name: &str| values.get(name).cloned();

        assert!(isolation_requested(&get));
        assert!(validate(&values).is_err());
    }

    #[test]
    fn rejects_dev_frontend_even_with_explicit_test_flag() {
        let (_root, mut values) = fixture();
        values.insert(TEST_FLAG.into(), "1".into());
        values.insert(DEV_FRONTEND_ENV.into(), "http://127.0.0.1:3060".into());

        assert!(validate(&values).is_err());
    }

    #[test]
    fn rejects_missing_required_isolation_values() {
        for name in [
            "O8_FORCE_BUNDLED_SERVERS",
            "O8_DATA_DIR",
            "CORTEX_IDE_DATA_DIR",
            "O8_API_PORT",
            "O8_WS_PORT",
            "O8_TAURI_MCP_SOCKET",
        ] {
            let (_root, mut values) = fixture();
            values.remove(name);
            assert!(validate(&values).is_err(), "{name} unexpectedly optional");
        }
    }

    #[test]
    fn rejects_production_data_directory_and_descendants() {
        let (_root, mut values) = fixture();
        let production = PathBuf::from(values.get("HOME").unwrap()).join(".o8");
        std::fs::create_dir_all(production.join("test-profile")).unwrap();
        for candidate in [production.clone(), production.join("test-profile")] {
            let value = candidate.to_string_lossy().into_owned();
            values.insert("O8_DATA_DIR".into(), value.clone());
            values.insert("CORTEX_IDE_DATA_DIR".into(), value);
            assert!(validate(&values).is_err());
        }
    }

    #[test]
    fn rejects_production_ports_and_default_socket() {
        let (_root, mut values) = fixture();
        for port in [47100, 47104, 47105, 47109] {
            values.insert("O8_API_PORT".into(), port.to_string());
            assert!(
                validate(&values).is_err(),
                "accepted production port {port}"
            );
        }

        let (_root, mut values) = fixture();
        values.insert(
            "O8_TAURI_MCP_SOCKET".into(),
            "/tmp/tauri-mcp-o8-test-user.sock".into(),
        );
        assert!(validate(&values).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_data_directory_symlinked_to_production() {
        use std::os::unix::fs::symlink;

        let (root, mut values) = fixture();
        let production = PathBuf::from(values.get("HOME").unwrap()).join(".o8");
        std::fs::create_dir_all(&production).unwrap();
        let alias = root.path().join("profile-alias");
        symlink(&production, &alias).unwrap();
        let value = alias.to_string_lossy().into_owned();
        values.insert("O8_DATA_DIR".into(), value.clone());
        values.insert("CORTEX_IDE_DATA_DIR".into(), value);
        assert!(validate(&values).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn canonicalizes_socket_parent_aliases() {
        use std::os::unix::fs::symlink;

        let (root, _values) = fixture();
        let real_parent = root.path().join("socket-parent");
        let alias_parent = root.path().join("socket-parent-alias");
        std::fs::create_dir_all(&real_parent).unwrap();
        symlink(&real_parent, &alias_parent).unwrap();

        assert_eq!(
            socket_path_identity(&real_parent.join("instance.sock")),
            socket_path_identity(&alias_parent.join("instance.sock")),
        );
    }
}
