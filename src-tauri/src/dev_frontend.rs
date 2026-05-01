pub const ENV_VAR: &str = "O8_DEV_FRONTEND_URL";

#[derive(Clone, Debug)]
pub struct DevFrontendOverride {
    url: tauri::Url,
    origin: String,
    port: u16,
}

impl DevFrontendOverride {
    pub fn url(&self) -> &tauri::Url {
        &self.url
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

pub fn from_env() -> Result<Option<DevFrontendOverride>, String> {
    let raw = match std::env::var(ENV_VAR) {
        Ok(raw) => raw.trim().to_string(),
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(format!("{} must be valid UTF-8", ENV_VAR));
        }
    };

    if raw.is_empty() {
        return Ok(None);
    }

    parse(&raw).map(Some)
}

pub fn apply_to_main_window_config(
    config: &mut tauri::Config,
    dev_frontend: &DevFrontendOverride,
) -> bool {
    let Some(window) = config
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
    else {
        return false;
    };
    window.url = tauri::WebviewUrl::External(dev_frontend.url().clone());
    true
}

fn parse(raw: &str) -> Result<DevFrontendOverride, String> {
    let url: tauri::Url = raw
        .parse()
        .map_err(|e| format!("{} must be a valid URL: {}", ENV_VAR, e))?;

    match url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "{} must use http:// or https://, got {}://",
                ENV_VAR, scheme
            ))
        }
    }

    let Some(host) = url.host_str() else {
        return Err(format!("{} must include a host", ENV_VAR));
    };
    let Some(port) = url.port() else {
        return Err(format!("{} must include an explicit port", ENV_VAR));
    };

    Ok(DevFrontendOverride {
        origin: format!(
            "{}://{}:{}",
            url.scheme(),
            format_host_for_origin(host),
            port
        ),
        url,
        port,
    })
}

fn format_host_for_origin(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{}]", host)
    } else {
        host.to_string()
    }
}
