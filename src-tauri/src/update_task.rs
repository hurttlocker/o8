//! A stopped receipt is written only after the owning future and installer have unwound.
use std::path::PathBuf;

pub struct TaskOwner {
    path: PathBuf,
    id: String,
}
impl TaskOwner {
    pub fn new(directory: PathBuf, id: &str) -> Result<Self, String> {
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let owner = Self {
            path: directory.join(format!("{id}.json")),
            id: id.into(),
        };
        owner.save("running")?;
        Ok(owner)
    }
    fn save(&self, status: &str) -> Result<(), String> {
        let temporary = self.path.with_extension("tmp");
        std::fs::write(
            &temporary,
            serde_json::json!({ "attemptId": self.id,
            "pid": std::process::id(), "status": status })
            .to_string(),
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(temporary, &self.path).map_err(|e| e.to_string())
    }
}
impl Drop for TaskOwner {
    fn drop(&mut self) {
        let _ = self.save("stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_completion_is_persisted_after_ownership_ends() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let id = uuid::Uuid::new_v4().to_string();
        let file = root.join(format!("{id}.json"));
        let task = TaskOwner::new(root.clone(), &id).unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().contains("running"));
        drop(task);
        assert!(std::fs::read_to_string(&file).unwrap().contains("stopped"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn aborted_native_task_records_stopped_before_ownership_can_be_recovered() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let id = uuid::Uuid::new_v4().to_string();
        let file = root.join(format!("{id}.json"));
        let directory = root.clone();
        let (send, started) = std::sync::mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            let _owner = TaskOwner::new(directory, &id).unwrap();
            send.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().contains("running"));
        task.abort();
        assert!(tauri::async_runtime::block_on(task).is_err());
        assert!(std::fs::read_to_string(&file).unwrap().contains("stopped"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
