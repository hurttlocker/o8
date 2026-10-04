use crate::{
    configuration::Store,
    models::{
        ClientClient as Client, ClientClientWrappedOrganizationMembershipsResponse,
        ClientEnvironment as Environment, ClientOrganization as Organization,
        ClientOrganizationMembership, ClientSession as Session, ClientUser as User,
    },
    ClerkFapiConfiguration,
};
use log::{error, warn};
use std::{error::Error, fmt, sync::Arc};

pub type ClerkStateCallback = Arc<
    dyn Fn(Client, Option<Session>, Option<User>, Option<Organization>) + Send + Sync + 'static,
>;

/// Internal state of our Clerk
pub struct ClerkState {
    /// Clerk environment describing current Clerk instance capabilities
    environment: Option<Environment>,
    /// The core Clerk Client object maintaining state of the current
    /// instance state, like Sessions, last active session, User,
    /// SignIns and SignUps etc.
    client: Option<Client>,
    /// In non standard browser enviroments where one cannot rely on
    /// cookies Clerk uses Authorization header to identify the Client
    /// That's passed in in requests, and updated based on response
    /// Headers
    authorization_header: Option<String>,
    /// Currently active session if any
    session: Option<Session>,
    /// Currently active user if any
    user: Option<User>,
    /// Curretnly selected organization if any
    organization: Option<Organization>,
    /// Indication if clerk state has been loaded
    /// this means there is Envrionment, and Client eiter loaded from
    /// API, some local storgae, or passed in in multi progamming language
    /// environement from other process
    pub loaded: bool,
    /// When activating new organization this flag is set to identify
    /// which organization from user to attach to the the organization
    /// field from the Client Session
    pub target_organization_id: Option<Option<String>>,
    /// Config to access the store
    config: ClerkFapiConfiguration,
    /// Callback for Client state change
    callback: ClerkStateCallback,
}

impl fmt::Debug for ClerkState {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.debug_struct("ClerkState")
            .field("loaded", &self.loaded)
            .finish()
    }
}

#[derive(Debug)]
pub enum ClerkNotLoadedError {
    NotLoaded,
    MissingEnvironment,
    MissingClient,
}
impl fmt::Display for ClerkNotLoadedError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ClerkNotLoadedError::NotLoaded => write!(f, "Clerk state not loaded"),
            ClerkNotLoadedError::MissingEnvironment => write!(f, "Missing environment"),
            ClerkNotLoadedError::MissingClient => write!(f, "Missing client"),
        }
    }
}
impl Error for ClerkNotLoadedError {}

impl ClerkState {
    pub fn new<F>(config: ClerkFapiConfiguration, callback: F) -> Self
    where
        F: Fn(Client, Option<Session>, Option<User>, Option<Organization>) + Send + Sync + 'static,
    {
        Self {
            environment: None,
            client: None,
            authorization_header: None,
            session: None,
            user: None,
            organization: None,
            loaded: false,
            target_organization_id: None,
            config,
            callback: Arc::new(callback),
        }
    }
    /// Doesn't matter how we end up loading the environemnt and client
    /// Here we mark the set the current state and mark the state loaded
    pub fn set_loaded(&mut self, environment: Environment, client: Client) {
        self.set_environment(environment);
        self.set_client(client);
        self.loaded = true;
    }

    /// Call this before setting new client to determine if one should
    /// also emit change after setting client. Useful to avoid emiting
    /// extra events when nothing has changed
    pub fn should_emit_client_change(&self, client: Client) -> Result<bool, ClerkNotLoadedError> {
        if !self.loaded {
            Err(ClerkNotLoadedError::NotLoaded)
        } else {
            match (self.client.clone(), self.target_organization_id.clone()) {
                (None, _) => Ok(true),    // No client yet, definitely emit
                (_, Some(_)) => Ok(true), // We have target_organization_id so we're going though org activation
                (Some(old_client), _) => Ok(client != old_client), // Othewise let's check if the client changed
            }
        }
    }

    pub fn emit_state(&self) {
        if let Some(client) = self.client.clone() {
            (self.callback)(
                client,
                self.session.clone(),
                self.user.clone(),
                self.organization.clone(),
            );
        } else {
            error!("ClerkState: Tried to emit state when no client available");
        }
    }

    pub fn environment(&self) -> Result<Environment, ClerkNotLoadedError> {
        if !self.loaded {
            Err(ClerkNotLoadedError::NotLoaded)
        } else {
            self.environment
                .clone()
                .ok_or(ClerkNotLoadedError::MissingEnvironment)
        }
    }
    pub fn set_environment(&mut self, environment: Environment) {
        self.environment = Some(environment.clone());
        if let Ok(value) = serde_json::to_value(environment.clone()) {
            self.config.set_store_value("environment", value);
        } else {
            error!("ClerkState: Failed to serialize environment");
        }
    }

    pub fn client(&self) -> Result<Client, ClerkNotLoadedError> {
        if !self.loaded {
            Err(ClerkNotLoadedError::NotLoaded)
        } else {
            self.client
                .clone()
                .ok_or(ClerkNotLoadedError::MissingClient)
        }
    }
    pub fn set_client(&mut self, client: Client) {
        self.client = Some(client.clone());
        if let Ok(value) = serde_json::to_value(client.clone()) {
            self.config.set_store_value("client", value);
        } else {
            error!("ClerkState: Failed to serialize client");
        }

        let client_clone = client.clone();

        if let Some(active_session) = client_clone.last_active_session_id.as_ref().and_then(|id| {
            client_clone
                .sessions
                .iter()
                .find(|s| s.id == id.clone())
                .cloned()
        }) {
            self.session = Some(active_session.clone());
            if let Some(user) = active_session.user {
                self.user = Some(*user.clone());

                // In case there is target_org_id we've explitly set which org we want
                // to unpack, else we just pick the last active org from the session
                // as we get new client on many requests and the session there has
                // the last active session
                let target_org_id = self.target_organization_id.clone();
                let org_id_target = if let Some(org_id) = target_org_id {
                    org_id
                } else {
                    active_session.last_active_organization_id
                };

                // We've consumed the value, so reseting
                self.target_organization_id = None;

                if let Some(last_active_org_id) = org_id_target {
                    if let Some(ref memberships) = user.organization_memberships {
                        if let Some(active_org) = memberships
                            .iter()
                            .find(|m| m.organization.id == last_active_org_id.clone())
                            .map(|m| m.organization.clone())
                        {
                            self.organization = Some(*active_org);
                        }
                    }
                } else {
                    self.organization = None;
                }
            }
        } else {
            self.session = None;
            self.user = None;
            self.organization = None;
        }
    }

    pub fn authorization_header(&mut self) -> Option<String> {
        match self.authorization_header.clone() {
            Some(token) => Some(token),
            None => {
                // try to load from store
                let stored_token = self.config.get_store_value("authorization_header");
                match stored_token {
                    Some(token_value) => {
                        if let Ok(token) = serde_json::from_value::<Option<String>>(token_value) {
                            // there was a token! let's update also internal state
                            self.authorization_header = token.clone();
                            token
                        } else {
                            warn!("Failed to parse stored authorization header");
                            None
                        }
                    }
                    None => None,
                }
            }
        }
    }
    pub fn set_authorization_header(&mut self, authorization_header: Option<String>) {
        self.authorization_header = authorization_header.clone();
        if let Ok(value) = serde_json::to_value(authorization_header.clone()) {
            self.config.set_store_value("authorization_header", value);
        } else {
            error!("ClerkState: Failed to serialize authorization_header");
        }
    }

    pub fn session(&self) -> Result<Option<Session>, ClerkNotLoadedError> {
        if !self.loaded {
            Err(ClerkNotLoadedError::NotLoaded)
        } else {
            Ok(self.session.clone())
        }
    }
    // No extrenal setter for session

    pub fn user(&self) -> Result<Option<User>, ClerkNotLoadedError> {
        if !self.loaded {
            Err(ClerkNotLoadedError::NotLoaded)
        } else {
            Ok(self.user.clone())
        }
    }
    // No extrenal setter for user

    pub fn organization(&self) -> Result<Option<Organization>, ClerkNotLoadedError> {
        if !self.loaded {
            Err(ClerkNotLoadedError::NotLoaded)
        } else {
            Ok(self.organization.clone())
        }
    }
    // No external setter for organization

    /// When selecting or swiching active orgnization, we set target organization id
    ///so that when we get new client we can unpack correct organization from the user object
    pub fn set_target_orgnization(&mut self, target_organization_id: Option<String>) {
        self.target_organization_id = Some(target_organization_id);
    }
}
