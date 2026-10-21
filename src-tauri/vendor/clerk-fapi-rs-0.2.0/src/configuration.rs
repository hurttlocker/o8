use crate::apis::configuration::Configuration as ApiConfiguration;
use crate::clerk_http_client::ClerkHttpClient;
use base64::{engine::general_purpose, Engine as _};
use futures::future::BoxFuture;
use parking_lot::RwLock;
use pin_project_lite::pin_project;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::str;
use std::sync::Arc;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const NAME: &str = env!("CARGO_PKG_NAME");
const PUBLISHABLE_KEY_LIVE_PREFIX: &str = "pk_live_";
const PUBLISHABLE_KEY_TEST_PREFIX: &str = "pk_test_";

#[derive(Debug, Clone)]
struct PublishableKey {
    instance_type: String,
    frontend_api: String,
}

fn parse_publishable_key(
    key: &str,
    domain: Option<String>,
    proxy_url: Option<String>,
) -> Result<PublishableKey, String> {
    if key.is_empty() || !is_publishable_key(key) {
        return Err("Publishable key not valid.".to_string());
    }

    let instance_type = if key.starts_with(PUBLISHABLE_KEY_LIVE_PREFIX) {
        "production".to_string()
    } else {
        "development".to_string()
    };

    let mut frontend_api = match public_key_url(key) {
        Ok(decoded) => decoded,
        Err(_) => return Err("Failed to decode frontend API".to_string()),
    };

    frontend_api.pop(); // Remove the last character as it's $

    if let Some(proxy) = proxy_url {
        frontend_api = proxy;
    } else if instance_type != "development" {
        if let Some(d) = domain {
            frontend_api = format!("clerk.{d}");
        }
    }

    Ok(PublishableKey {
        instance_type,
        frontend_api,
    })
}

fn public_key_base64_segment(key: &str) -> String {
    let mut base64_segment = key.split('_').nth(2).unwrap_or("").to_string();
    while !base64_segment.len().is_multiple_of(4) {
        base64_segment.push('=');
    }
    base64_segment
}

fn public_key_url(key: &str) -> Result<String, String> {
    let base64_segment = public_key_base64_segment(key);
    match general_purpose::URL_SAFE.decode(base64_segment) {
        Ok(decoded) => match str::from_utf8(&decoded) {
            Ok(decoded_str) => Ok(decoded_str.to_string()),
            Err(_) => Err("Failed to decode frontend API".to_string()),
        },
        Err(_) => Err("Failed to decode frontend API".to_string()),
    }
}

fn is_publishable_key(key: &str) -> bool {
    let has_valid_prefix = key.starts_with(PUBLISHABLE_KEY_LIVE_PREFIX)
        || key.starts_with(PUBLISHABLE_KEY_TEST_PREFIX);

    let has_valid_frontend_api_postfix = match public_key_url(key) {
        Ok(decoded_str) => decoded_str.ends_with('$'),
        Err(_) => false,
    };

    has_valid_prefix && has_valid_frontend_api_postfix
}

pub trait Store: Send + Sync + std::fmt::Debug {
    /// Inserts a key-value pair into the store.
    fn set(&self, key: &str, value: JsonValue);

    /// Returns the value for the given `key` or `None` if the key does not exist.
    fn get(&self, key: &str) -> Option<JsonValue>;

    /// Returns `true` if the given `key` exists in the store.
    fn has(&self, key: &str) -> bool;

    /// Removes a key-value pair from the store.
    /// Returns true if a value was removed, false if the key didn't exist.
    fn delete(&self, key: &str) -> bool;
}

#[derive(Clone, Default, Debug)]
pub struct DefaultStore {
    inner: Arc<RwLock<HashMap<String, JsonValue>>>,
}

impl Store for DefaultStore {
    fn set(&self, key: &str, value: JsonValue) {
        let mut store = self.inner.write();
        store.insert(key.to_string(), value);
    }

    fn get(&self, key: &str) -> Option<JsonValue> {
        let store = self.inner.read();
        store.get(key).cloned()
    }

    fn has(&self, key: &str) -> bool {
        let store = self.inner.read();
        store.contains_key(key)
    }

    fn delete(&self, key: &str) -> bool {
        let mut store = self.inner.write();
        store.remove(key).is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ClientKind {
    Browser,
    NonBrowser,
}

#[derive(Debug, Clone)]
pub struct ClerkFapiConfiguration {
    pub(crate) base_url: String,
    pub(crate) instance_type: String,
    pub(crate) frontend_api: String,
    pub(crate) user_agent: String,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) store_prefix: String,
    pub(crate) kind: ClientKind,
}

impl ClerkFapiConfiguration {
    /// Creates a new ClerkFapiConfiguration with default store and prefix
    pub fn new(
        key: String,
        proxy_url: Option<String>,
        domain: Option<String>,
    ) -> Result<Self, String> {
        Self::new_with_store(key, proxy_url, domain, None, None, ClientKind::NonBrowser)
    }

    /// Creates a new ClerkFapiConfiguration with custom store and/or prefix
    pub fn new_browser(
        key: String,
        proxy_url: Option<String>,
        domain: Option<String>,
    ) -> Result<Self, String> {
        Self::new_with_store(key, proxy_url, domain, None, None, ClientKind::Browser)
    }

    /// Creates a new ClerkFapiConfiguration with custom store and/or prefix
    pub fn new_with_store(
        key: String,
        proxy_url: Option<String>,
        domain: Option<String>,
        store: Option<Arc<dyn Store>>,
        store_prefix: Option<String>,
        kind: ClientKind,
    ) -> Result<Self, String> {
        let parsed_key = parse_publishable_key(&key, domain.clone(), proxy_url.clone())?;
        let user_agent = format!("{NAME}/{VERSION}");

        let store = store.unwrap_or_else(|| Arc::new(DefaultStore::default()));
        let store_prefix = store_prefix.unwrap_or_else(|| "ClerkFapi:".to_string());

        Ok(Self {
            base_url: if parsed_key.frontend_api.starts_with("http://")
                || parsed_key.frontend_api.starts_with("https://")
            {
                parsed_key.frontend_api.to_string()
            } else {
                format!("https://{}", parsed_key.frontend_api)
            },
            instance_type: parsed_key.instance_type,
            frontend_api: parsed_key.frontend_api,
            user_agent,
            store,
            store_prefix,
            kind,
        })
    }

    /// Returns the base URL for API requests
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Returns the instance type ("production" or "development")
    pub fn instance_type(&self) -> &str {
        &self.instance_type
    }

    /// Returns the frontend API
    pub fn frontend_api(&self) -> &str {
        &self.frontend_api
    }

    /// Returns the User-Agent string
    pub fn user_agent(&self) -> &str {
        &self.user_agent
    }

    /// Returns a reference to the store
    pub fn store(&self) -> &dyn Store {
        &*self.store
    }

    /// Returns the store prefix
    pub fn store_prefix(&self) -> &str {
        &self.store_prefix
    }

    /// Helper method to get prefixed key
    fn get_prefixed_key(&self, key: impl AsRef<str>) -> String {
        format!("{}{}", self.store_prefix, key.as_ref())
    }

    /// Set a value in the store with the configured prefix
    pub fn set_store_value(&self, key: impl AsRef<str>, value: impl Into<JsonValue>) {
        let prefixed_key = self.get_prefixed_key(key);
        self.store.set(&prefixed_key, value.into());
    }

    /// Get a value from the store using the configured prefix
    pub fn get_store_value(&self, key: impl AsRef<str>) -> Option<JsonValue> {
        let prefixed_key = self.get_prefixed_key(key);
        self.store.get(&prefixed_key)
    }

    /// Check if a key exists in the store (using the configured prefix)
    pub fn has_store_value(&self, key: impl AsRef<str>) -> bool {
        let prefixed_key = self.get_prefixed_key(key);
        self.store.has(&prefixed_key)
    }

    /// Delete a value from the store (using the configured prefix)
    pub fn delete_store_value(&self, key: impl AsRef<str>) -> bool {
        let prefixed_key = self.get_prefixed_key(key);
        self.store.delete(&prefixed_key)
    }

    /// Returns whether this is a production instance
    pub fn is_production(&self) -> bool {
        self.instance_type == "production"
    }

    /// Returns whether this is a development instance
    pub fn is_development(&self) -> bool {
        self.instance_type == "development"
    }

    /// Convert this configuration into an API configuration that can be used with generated API methods
    pub fn into_api_configuration(&self, client: Arc<ClerkHttpClient>) -> ApiConfiguration {
        let user_agent = match self.kind {
            ClientKind::Browser => None,
            ClientKind::NonBrowser => Some(self.user_agent.clone()),
        };

        ApiConfiguration {
            base_path: self.base_url.clone(),
            client,
            api_key: None,
            basic_auth: None,
            oauth_access_token: None,
            user_agent,
            bearer_access_token: None,
        }
    }
}

impl fmt::Display for ClerkFapiConfiguration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Configuration {{ base_url: {}, instance_type: {}, frontend_api: {}, user_agent: {} }}",
            self.base_url, self.instance_type, self.frontend_api, self.user_agent
        )
    }
}

impl Default for ClerkFapiConfiguration {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            instance_type: String::new(),
            frontend_api: String::new(),
            user_agent: format!("{NAME}/{VERSION}"),
            store: Arc::new(DefaultStore::default()),
            store_prefix: "ClerkFapi:".to_string(),
            kind: ClientKind::NonBrowser,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_with_development_key() {
        let config =
            ClerkFapiConfiguration::new("pk_test_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(), None, None)
                .unwrap();
        assert_eq!(config.instance_type(), "development");
        assert!(config.is_development());
        assert!(!config.is_production());
        assert!(config.base_url().starts_with("https://"));
        assert_eq!(config.user_agent(), format!("{NAME}/{VERSION}"));
    }

    #[test]
    fn test_new_with_production_key() {
        let config =
            ClerkFapiConfiguration::new("pk_live_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(), None, None)
                .unwrap();
        assert_eq!(config.instance_type(), "production");
        assert!(config.is_production());
        assert!(!config.is_development());
    }

    #[test]
    fn test_new_with_proxy() {
        let config = ClerkFapiConfiguration::new(
            "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(),
            Some("proxy.example.com".to_string()),
            None,
        )
        .unwrap();
        assert_eq!(config.base_url(), "https://proxy.example.com");
    }

    #[test]
    fn test_new_with_domain() {
        let config = ClerkFapiConfiguration::new(
            "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(),
            None,
            Some("example.com".to_string()),
        )
        .unwrap();
        assert_eq!(config.frontend_api(), "clerk.example.com");
        assert_eq!(config.base_url(), "https://clerk.example.com");
    }

    #[test]
    fn test_proxy_takes_precedence_over_domain() {
        let config = ClerkFapiConfiguration::new(
            "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(),
            Some("proxy.example.com".to_string()),
            Some("clerk.example.com".to_string()),
        )
        .unwrap();
        assert_eq!(config.frontend_api(), "proxy.example.com");
    }

    #[test]
    fn test_invalid_key() {
        let result = ClerkFapiConfiguration::new("invalid_key".to_string(), None, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_key() {
        let result = ClerkFapiConfiguration::new("".to_string(), None, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_default_store() {
        let config =
            ClerkFapiConfiguration::new("pk_test_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(), None, None)
                .unwrap();

        let store = config.store();
        store.set("test_key", serde_json::json!("test_value"));

        assert!(store.has("test_key"));
        assert_eq!(
            store.get("test_key").unwrap(),
            serde_json::json!("test_value")
        );

        assert!(store.delete("test_key"));
        assert!(!store.has("test_key"));
    }

    #[test]
    fn test_custom_store() {
        #[derive(Debug)]
        struct MockStore(DefaultStore);

        impl Store for MockStore {
            fn set(&self, key: &str, value: JsonValue) {
                self.0.set(key, value)
            }

            fn get(&self, key: &str) -> Option<JsonValue> {
                self.0.get(key)
            }

            fn has(&self, key: &str) -> bool {
                self.0.has(key)
            }

            fn delete(&self, key: &str) -> bool {
                self.0.delete(key)
            }
        }

        let mock_store = Arc::new(MockStore(DefaultStore::default()));
        let config = ClerkFapiConfiguration::new_with_store(
            "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(),
            None,
            None,
            Some(mock_store.clone()),
            None,
            ClientKind::NonBrowser,
        )
        .unwrap();

        config
            .store()
            .set("test_key", serde_json::json!("test_value"));
        assert!(config.store().has("test_key"));
    }

    #[test]
    fn test_default_store_prefix() {
        let config =
            ClerkFapiConfiguration::new("pk_test_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(), None, None)
                .unwrap();

        assert_eq!(config.store_prefix(), "ClerkFapi:");

        // Test store operations with prefix
        config.set_store_value("test_key", "test_value");
        assert!(config.has_store_value("test_key"));
        assert_eq!(
            config.get_store_value("test_key").unwrap(),
            serde_json::json!("test_value")
        );

        // Verify the actual key in store includes prefix
        assert!(config.store().has("ClerkFapi:test_key"));

        assert!(config.delete_store_value("test_key"));
        assert!(!config.has_store_value("test_key"));
    }

    #[test]
    fn test_custom_store_prefix() {
        let config = ClerkFapiConfiguration::new_with_store(
            "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(),
            None,
            None,
            None,
            Some("CustomPrefix:".to_string()),
            ClientKind::NonBrowser,
        )
        .unwrap();

        assert_eq!(config.store_prefix(), "CustomPrefix:");

        config.set_store_value("test_key", "test_value");
        assert!(config.store().has("CustomPrefix:test_key"));
    }

    #[test]
    fn test_store_operations_with_prefix() {
        let config = ClerkFapiConfiguration::new_with_store(
            "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k".to_string(),
            None,
            None,
            None,
            Some("Test:".to_string()),
            ClientKind::NonBrowser,
        )
        .unwrap();

        // Set and verify a value
        config.set_store_value("key1", "value1");
        assert!(config.has_store_value("key1"));
        assert_eq!(
            config.get_store_value("key1").unwrap(),
            serde_json::json!("value1")
        );

        // Delete and verify
        assert!(config.delete_store_value("key1"));
        assert!(!config.has_store_value("key1"));

        // Verify with direct store access
        assert!(!config.store().has("Test:key1"));
    }

    #[test]
    fn test_default_implementation() {
        let config = ClerkFapiConfiguration::default();
        assert_eq!(config.base_url(), "");
        assert_eq!(config.instance_type(), "");
        assert_eq!(config.frontend_api(), "");
        assert_eq!(config.user_agent(), format!("{NAME}/{VERSION}"));
        assert_eq!(config.store_prefix(), "ClerkFapi:");

        // Test that the default store works
        config.set_store_value("test_key", "test_value");
        assert!(config.has_store_value("test_key"));
    }
}
