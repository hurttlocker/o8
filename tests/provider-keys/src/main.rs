#![allow(dead_code)]
#[path = "../../../src-tauri/src/stt/keys.rs"] pub mod native_keys;
mod stt {
    pub mod commands {
        pub struct ReplacementRule { pub trigger: String, pub replacement: String }
    }
    pub use crate::native_keys as keys;
}
fn main() {
    use std::io::Read;
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let command: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let result = match command["action"].as_str().unwrap() {
        "save" => stt::keys::set_pref(command["pref"].as_str().unwrap(), command["value"].clone()).map(|_| serde_json::json!(true)),
        "migrate" => o8_provider_keys::migrate_legacy(command["name"].as_str().unwrap(), command["value"].as_str().unwrap()).map(|v| serde_json::json!(v)),
        "crash-lock" => {
            let lock = rusqlite::Connection::open(o8_provider_keys::data_dir().join(".provider-keys.lock")).unwrap();
            lock.execute_batch("BEGIN EXCLUSIVE").unwrap();
            println!("{{\"ok\":true}}");
            std::process::exit(0);
        },
        "read" => Ok(serde_json::json!(match command["pref"].as_str() {
            Some("gemini_api_key") => stt::keys::get_gemini_key(),
            Some("groq_api_key") => stt::keys::get_groq_key(),
            Some("elevenlabs_api_key") => stt::keys::get_elevenlabs_key(),
            Some("google_tts_api_key") => stt::keys::get_google_tts_key(),
            _ => stt::keys::get_openrouter_key(),
        })),
        "public" => Ok(stt::keys::config_public()),
        _ => panic!("unknown test operation"),
    };
    match result {
        Ok(value) => println!("{}", serde_json::json!({"ok": true, "value": value})),
        Err(_) => println!("{}", serde_json::json!({"ok": false})),
    }
}
#[cfg(test)]
mod bridge_tests {
    #[test]
    fn native_reader_uses_the_node_store() {
        const CHILD: &str = "O8_TEST_SHARED_KEY_CHILD";
        if std::env::var(CHILD).as_deref() == Ok("1") {
            assert_eq!(super::stt::keys::get_openrouter_key().as_deref(), Some("fixture-shared-key"));
            return;
        }
        let dir = std::env::temp_dir().join(format!("o8-key-bridge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env.local"), "OPENROUTER_API_KEY=fixture-shared-key\n").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "bridge_tests::native_reader_uses_the_node_store"])
            .env(CHILD, "1").env("O8_DATA_DIR", &dir)
            .env("O8_TEST_DISABLE_VOICE_PROVIDER_KEYS", "1")
            .env_remove("OPENROUTER_API_KEY").output().unwrap();
        let _ = std::fs::remove_dir_all(dir);
        assert!(output.status.success(), "native reader did not resolve the shared store");
    }
}

#[cfg(test)]
mod mutation_tests {
    #[test]
    fn native_save_check_disable_remove_survive_restart() {
        let stage = std::env::var("O8_TEST_NATIVE_KEY_STAGE").ok();
        if let Some(stage) = stage {
            match stage.as_str() {
                "save" => super::stt::keys::set_pref("openrouter_api_key", serde_json::json!("fixture-native-key")).unwrap(),
                "disable" => super::stt::keys::set_pref("openrouter_enabled", serde_json::json!(false)).unwrap(),
                "enable" => super::stt::keys::set_pref("openrouter_enabled", serde_json::json!(true)).unwrap(),
                "remove" => super::stt::keys::set_pref("openrouter_api_key", serde_json::json!("")).unwrap(),
                "check" => {
                    assert_eq!(super::stt::keys::get_openrouter_key().as_deref(), Some("fixture-native-key"));
                    assert_eq!(super::stt::keys::config_public()["openrouter_api_key_set"], true);
                },
                "absent" => assert!(super::stt::keys::get_openrouter_key().is_none()),
                _ => panic!("unknown stage"),
            }
            return;
        }
        let dir = std::env::temp_dir().join(format!("o8-native-mutations-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for stage in ["save", "check", "disable", "absent", "enable", "check", "remove", "absent"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "mutation_tests::native_save_check_disable_remove_survive_restart"])
                .env("O8_DATA_DIR", &dir).env("O8_TEST_NATIVE_KEY_STAGE", stage)
                .env("O8_MASTER_KEY", "JSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSU")
                .env("O8_TEST_DISABLE_VOICE_PROVIDER_KEYS", "1")
                .env_remove("OPENROUTER_API_KEY").output().unwrap();
            assert!(output.status.success(), "native restart stage failed: {}", stage);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
