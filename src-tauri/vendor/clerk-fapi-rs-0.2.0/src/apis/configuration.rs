use std::sync::Arc;

use crate::{clerk_http_client::ClerkHttpClient, configuration::ClientKind};

#[derive(Debug)]
pub struct Configuration {
    pub base_path: String,
    pub user_agent: Option<String>,
    pub client: Arc<ClerkHttpClient>,
    pub basic_auth: Option<BasicAuth>,
    pub oauth_access_token: Option<String>,
    pub bearer_access_token: Option<String>,
    pub api_key: Option<ApiKey>,
}

pub type BasicAuth = (String, Option<String>);

#[derive(Debug, Clone)]
pub struct ApiKey {
    pub prefix: Option<String>,
    pub key: String,
}
