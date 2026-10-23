use crate::model::History;
use serde::{Deserialize, de::DeserializeOwned};
use std::{io::Read, time::Duration};
use url::{Host, Url};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub runtime: String,
    pub status: String,
    pub message_count: usize,
}
#[derive(Deserialize)]
struct Sessions {
    threads: Vec<Session>,
}

#[derive(Clone)]
pub struct Client {
    origin: Url,
    agent: ureq::Agent,
}
impl Client {
    pub fn new(origin: &str) -> Result<Self, String> {
        let origin = Url::parse(origin).map_err(|_| "Invalid server URL")?;
        let loopback = match origin.host() {
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if origin.scheme() != "http"
            || !loopback
            || origin.port().is_none()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return Err("Use an explicit http://127.0.0.1:PORT or http://[::1]:PORT origin".into());
        }
        Ok(Self {
            origin,
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .try_proxy_from_env(false)
                .timeout(Duration::from_secs(5))
                .build(),
        })
    }
    fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T, String> {
        let mut url = self.origin.join(path).map_err(|_| "Invalid route")?;
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        let response = self.agent.get(url.as_str()).call().map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("Server returned HTTP {code}"),
            _ => "Could not reach the selected server".into(),
        })?;
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read history")?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("History response exceeds 16 MiB".into());
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| "Server returned an invalid transcript response".into())
    }
    pub fn sessions(&self) -> Result<Vec<Session>, String> {
        Ok(self
            .get::<Sessions>("/api/mobile/orchestrator/threads", &[("limit", "500")])?
            .threads)
    }
    pub fn history(&self, id: &str) -> Result<History, String> {
        let key = format!("llm-chat:{id}");
        let history: History = self.get(
            "/api/mobile/history",
            &[("sessionKey", &key), ("limit", "100")],
        )?;
        if history.session_key != key {
            return Err("Server returned history for a different session".into());
        }
        Ok(history)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_loopback_only() {
        for s in [
            "http://example.com:3000",
            "http://localhost:3000",
            "http://127.0.0.1",
            "http://127.0.0.1:3000/other",
            "http://x@127.0.0.1:3000",
            "http://127.0.0.1:3000?token=secret",
            "https://127.0.0.1:3000",
        ] {
            assert!(Client::new(s).is_err(), "{s}");
        }
        assert!(Client::new("http://127.0.0.1:32000").is_ok());
        assert!(Client::new("http://[::1]:32000").is_ok());
    }
}
