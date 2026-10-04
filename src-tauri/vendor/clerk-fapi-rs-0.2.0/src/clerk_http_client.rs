use log::{debug, error, warn};
use parking_lot::RwLock;
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Client as ReqwestClient, Request, Response};
use std::sync::Arc;

use crate::{clerk_state::ClerkState, configuration::ClientKind};

/// Custom client wrapper that behaves like reqwest::Client but adds Clerk-specific functionality
#[derive(Debug)]
pub struct ClerkHttpClient {
    inner: ReqwestClient,
    state: Arc<RwLock<ClerkState>>,
    client_kind: ClientKind,
    dev_browser_token_id: RwLock<Option<String>>,
}

impl std::fmt::Display for ClerkHttpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ClerkHttpClient")
    }
}

/// ClerkHttpClient that mimics ReqwestClient with pre and post hooks
/// To be able to run Clerk in non browser environment we need to
/// identify our selves to Clerk with Client Authorization header
/// We inject the header to the request and parse returned header
/// and keep the ClerkState updated with most current value
impl ClerkHttpClient {
    /// Creates a new ClerkHttpClient
    pub fn new(
        client: ReqwestClient,
        state: Arc<RwLock<ClerkState>>,
        client_kind: ClientKind,
    ) -> Self {
        Self {
            inner: client,
            state,
            client_kind,
            dev_browser_token_id: RwLock::new(None),
        }
    }

    /// When running in browser one needs "DevBrowser auth" when
    /// running against Clerk development environment
    pub fn set_dev_browser_token_id(&self, token_id: String) {
        let mut write_guard = self.dev_browser_token_id.write();
        *write_guard = Some(token_id);
    }

    /// Process the request before sending
    fn process_request(&self, mut req: Request) -> Request {
        // When running in non standard browser we need to tell Clerk
        // API that with the _is_native query parameter
        let url = req.url_mut();
        if self.client_kind == ClientKind::NonBrowser {
            url.query_pairs_mut().append_pair("_is_native", "1");
        }

        let token_id = {
            let read_guard = self.dev_browser_token_id.read();
            read_guard.clone()
        };

        if let Some(dev_browser_token_id) = token_id {
            url.query_pairs_mut()
                .append_pair("__clerk_db_jwt", &dev_browser_token_id);
        }

        {
            let mut state = self.state.write();
            match state.authorization_header() {
                Some(auth) => {
                    if let Ok(value) = HeaderValue::from_str(auth.as_str()) {
                        req.headers_mut().insert("Authorization", value);
                    } else {
                        error!("ClerkHttpClient: Failed to parse authorization header");
                    }
                }
                None => {
                    debug!("ClerkHttpClient: No authorization header available");
                }
            }
        }

        req
    }

    fn process_response(&self, resp: &Response) {
        if let Some(auth_header) = resp.headers().get("Authorization") {
            if let Ok(auth_str) = auth_header.to_str() {
                let mut state = self.state.write();
                state.set_authorization_header(Some(auth_str.to_string()));
            } else {
                error!("ClerkHttpClient: Failed to parse authorization header");
            }
        } else {
            // TODO: figure out if we need to clear the header value?
            //
        }
    }

    pub async fn execute(&self, request: Request) -> Result<Response, reqwest::Error> {
        // FOR DEBUG
        // let method = request.method().clone();
        // let url = request.url().clone();
        // END FOR DEBUG

        let processed_request = self.process_request(request);
        let response = self.inner.execute(processed_request).await?;

        // FOR DEBUG
        // let status = response.status();
        // let version = response.version();
        // let headers = response.headers().clone();
        // let resp_text = response.text().await?;
        // println!("[DEBUG] Request {} {} -> Response {}", method, url, status);
        // println!("[DEBUG] Response body: {}", resp_text);
        // let mut builder = http::Response::builder().status(status).version(version);
        // let builder_headers = builder.headers_mut().unwrap();
        // for (key, value) in headers.iter() {
        //     builder_headers.insert(key, value.clone());
        // }
        // let response = Response::from(builder.body(resp_text).unwrap());
        // END FOR DEBUG

        self.process_response(&response);
        Ok(response)
    }

    pub fn request<U: reqwest::IntoUrl>(
        &self,
        method: reqwest::Method,
        url: U,
    ) -> reqwest::RequestBuilder {
        self.inner.request(method, url)
    }

    pub fn get<U: reqwest::IntoUrl>(&self, url: U) -> reqwest::RequestBuilder {
        self.inner.get(url)
    }

    pub fn post<U: reqwest::IntoUrl>(&self, url: U) -> reqwest::RequestBuilder {
        self.inner.post(url)
    }

    pub fn put<U: reqwest::IntoUrl>(&self, url: U) -> reqwest::RequestBuilder {
        self.inner.put(url)
    }

    pub fn patch<U: reqwest::IntoUrl>(&self, url: U) -> reqwest::RequestBuilder {
        self.inner.patch(url)
    }

    pub fn delete<U: reqwest::IntoUrl>(&self, url: U) -> reqwest::RequestBuilder {
        self.inner.delete(url)
    }

    pub fn head<U: reqwest::IntoUrl>(&self, url: U) -> reqwest::RequestBuilder {
        self.inner.head(url)
    }
}
