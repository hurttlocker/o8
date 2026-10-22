//! An interrupted or failed automatic install must require manual recovery for that version.
use std::path::PathBuf;

pub struct InstallJournal {
    directory: PathBuf,
}
impl InstallJournal {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    fn path(&self, version: &str) -> Result<PathBuf, String> {
        if version.is_empty()
            || !version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
        {
            return Err("Invalid update version".into());
        }
        Ok(self
            .directory
            .join("automatic-install-attempts")
            .join(format!("{version}.json")))
    }
    pub fn check(&self, version: &str) -> Result<(), String> {
        match std::fs::symlink_metadata(self.path(version)?) {
            Ok(_) => Err("This version already had an automatic install attempt. Use Install to retry manually.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
    pub fn install(
        &self,
        version: &str,
        install: impl FnOnce() -> Result<(), String>,
        after_install: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.check(version)?;
        let path = self.path(version)?;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(b"{\"outcome\":\"attempting\"}")
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        let result = install().and_then(|value| after_install().map(|_| value));
        // The pre-install marker already suppresses a retry if this write or the process fails.
        let _ = std::fs::write(
            path,
            serde_json::json!({"outcome": if result.is_ok() { "installed" } else { "failed" },
            "error": result.as_ref().err()})
            .to_string(),
        );
        result
    }
}
