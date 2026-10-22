//! Native automatic installs never depend on a webview listener or timer.
#[path = "update_install_journal.rs"]
pub(crate) mod install_journal;
#[path = "update_task.rs"]
mod task;
use reqwest::Client;
use serde_json::{json, Value};
use std::future::Future;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

pub trait Effects: Send + Sync {
    fn data_directory(&self) -> Result<Option<std::path::PathBuf>, String> {
        Ok(None)
    }
    fn install(
        &self,
        version: &str,
        attempt_id: &str,
    ) -> impl Future<Output = Result<bool, String>> + Send;
    fn restart(&self) -> Result<(), String>;
}

pub struct NativeEffects<R: Runtime> {
    pub app: AppHandle<R>,
    pub client: Client,
    pub base: String,
    pub token: String,
}

impl<R: Runtime> Effects for NativeEffects<R> {
    fn data_directory(&self) -> Result<Option<std::path::PathBuf>, String> {
        self.app
            .try_state::<o8_restart_safety::RestartSafety>()
            .map(|guard| Some(guard.data_directory()))
            .ok_or_else(|| "Native update ownership storage is not ready. Retry shortly.".into())
    }
    async fn install(&self, version: &str, attempt_id: &str) -> Result<bool, String> {
        let directory = self
            .data_directory()?
            .ok_or("Native update storage is unavailable")?;
        install_journal::InstallJournal::new(directory).check(version)?;
        #[cfg(target_os = "windows")]
        let app = self.app.clone();
        let Some(update) = crate::update_ping::check_with(&self.app, |builder| {
            #[cfg(target_os = "windows")]
            {
                let app = app.clone();
                builder.on_before_exit(move || {
                    // The plugin invokes this only after successful extraction. Its hook
                    // cannot return Result, so unwind into install_candidate on refusal.
                    if let Err(error) = commit_restart(&app) {
                        std::panic::panic_any(error);
                    }
                })
            }
            #[cfg(not(target_os = "windows"))]
            {
                builder
            }
        })
        .await?
        else {
            return Ok(false);
        };
        if update.version != version {
            return Err(
                "The available version changed; retry after the next recorded check.".into(),
            );
        }
        self.install_candidate(update, attempt_id).await
    }

    fn restart(&self) -> Result<(), String> {
        self.restart_with(|| self.app.restart())
    }
}

impl<R: Runtime> NativeEffects<R> {
    pub(crate) fn restart_with(
        &self,
        relaunch: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        commit_restart(&self.app)?;
        relaunch()
    }

    pub(crate) async fn install_candidate(
        &self,
        update: tauri_plugin_updater::Update,
        attempt_id: &str,
    ) -> Result<bool, String> {
        let version = &update.version;
        let directory = self
            .data_directory()?
            .ok_or("Native update storage is unavailable")?;
        let journal = install_journal::InstallJournal::new(directory);
        journal.check(version)?;
        // Match the existing manual release-health kill switch, including fail-open transport.
        let mut health_url =
            reqwest::Url::parse(&format!("{}/api/panel/release-health", self.base))
                .map_err(|e| e.to_string())?;
        health_url.query_pairs_mut().append_pair("version", version);
        if let Ok(response) = self
            .client
            .get(health_url)
            .timeout(Duration::from_secs(4))
            .bearer_auth(&self.token)
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(health) = response.json::<Value>().await {
                    if health["pulled"].as_bool() == Some(true) {
                        return Err("This release was paused. Waiting for a fixed build.".into());
                    }
                }
            }
        }
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        let admission = control(
            &self.client,
            &format!("{}/api/panel/app/update-state", self.base),
            &self.token,
            json!({ "action": "install", "attemptId": attempt_id }),
        )
        .await?;
        if admission["allowed"].as_bool() != Some(true) {
            return Err(format!(
                "Update deferred: {}",
                admission["state"]["autoApply"]["blockers"]["live"]
            ));
        }
        journal.install(
            version,
            || {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| update.install(bytes)))
                    .map_err(|_| {
                        "Native installer admission was refused; no restart was performed."
                            .to_string()
                    })?
                    .map_err(|e| e.to_string())
            },
            || Ok(()),
        )?;
        // Windows success exits inside the plugin. Any returned error stays here,
        // and its durable marker prevents an unchanged launch from retrying it.
        Ok(true)
    }
}

pub(crate) fn commit_restart<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let guard = app
        .try_state::<o8_restart_safety::RestartSafety>()
        .ok_or("Native restart safety is unavailable")?;
    let reservation = guard.prepare()?;
    if let Err(error) = guard.before_restart(Some(&reservation)) {
        let _ = guard.cancel(&reservation);
        return Err(error);
    }
    Ok(())
}

struct Attempt {
    id: String,
    version: String,
    installed: bool,
}

pub struct AutoApply {
    interval: Duration,
    last_attempt: Option<Instant>,
    attempt: Option<Attempt>,
    pending_id: Option<String>,
    failure_report: Option<Value>,
    owner: Option<task::TaskOwner>,
}

async fn control(client: &Client, url: &str, token: &str, action: Value) -> Result<Value, String> {
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&json!({ "autoApply": action }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("Automatic update admission is unavailable".into());
    }
    response.json().await.map_err(|e| e.to_string())
}

impl AutoApply {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_attempt: None,
            attempt: None,
            pending_id: None,
            failure_report: None,
            owner: None,
        }
    }
    pub async fn tick(&mut self, client: &Client, url: &str, token: &str, effects: &impl Effects) {
        if self
            .last_attempt
            .is_some_and(|at| at.elapsed() < self.interval)
        {
            return;
        }
        let result = self.apply(client, url, token, effects).await;
        // A long download is not a wake event or a reason to retry immediately.
        self.last_attempt = Some(Instant::now());
        if let Err(error) = result {
            log::warn!("[updater] auto-apply deferred: {error}");
        }
    }

    async fn apply(
        &mut self,
        client: &Client,
        url: &str,
        token: &str,
        effects: &impl Effects,
    ) -> Result<(), String> {
        if let Some(report) = &self.failure_report {
            control(client, url, token, report.clone()).await?;
            self.failure_report = None;
            return Ok(());
        }
        if self.attempt.is_none() {
            let id = self
                .pending_id
                .get_or_insert_with(|| uuid::Uuid::new_v4().to_string());
            if self.owner.is_none() {
                if let Some(directory) = effects.data_directory()? {
                    self.owner = Some(task::TaskOwner::new(
                        directory.join("native-update-tasks"),
                        id,
                    )?);
                }
            }
            let admission = control(
                client,
                url,
                token,
                json!({ "action": "admit", "attemptId": id }),
            )
            .await?;
            if admission["allowed"].as_bool() != Some(true) {
                return Ok(());
            }
            let version = admission["version"]
                .as_str()
                .ok_or("Missing update version")?
                .to_string();
            self.attempt = Some(Attempt {
                id: admission["attemptId"]
                    .as_str()
                    .ok_or("Missing update attempt")?
                    .into(),
                installed: admission["installed"].as_bool() == Some(true),
                version,
            });
        }
        let attempt = self.attempt.as_mut().unwrap();
        if !attempt.installed {
            match effects.install(&attempt.version, &attempt.id).await {
                Ok(true) => {
                    attempt.installed = true;
                }
                outcome => {
                    let error = outcome
                        .err()
                        .unwrap_or_else(|| "No update was available at install time.".into());
                    self.failure_report = Some(
                        json!({ "action": "failed", "attemptId": attempt.id, "error": error }),
                    );
                    self.attempt = None;
                    self.pending_id = None;
                    self.owner = None;
                    control(
                        client,
                        url,
                        token,
                        self.failure_report.as_ref().unwrap().clone(),
                    )
                    .await?;
                    self.failure_report = None;
                    return Ok(());
                }
            }
        }
        let admission = control(
            client,
            url,
            token,
            json!({ "action": "restart", "attemptId": attempt.id }),
        )
        .await?;
        if admission["attemptMissing"].as_bool() == Some(true) {
            self.attempt = None;
            self.pending_id = None;
            self.owner = None;
            return Ok(());
        }
        if admission["allowed"].as_bool() == Some(true) {
            if let Err(error) = effects.restart() {
                control(
                    client,
                    url,
                    token,
                    json!({ "action": "failed", "attemptId": attempt.id, "error": error }),
                )
                .await?;
                return Err(error);
            }
        }
        Ok(())
    }
}
