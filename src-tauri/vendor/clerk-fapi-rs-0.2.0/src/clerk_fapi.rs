use crate::apis::*;
use crate::clerk_http_client::ClerkHttpClient;
use crate::clerk_state::ClerkState;
use crate::configuration::{ClerkFapiConfiguration, ClientKind, DefaultStore, Store};
use crate::models::*;
use dev_browser_api::DevBrowser;
use log::error;
use parking_lot::{Mutex, RwLock};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Client, Request, Response};
use serde_json::Value as JsonValue;
use std::borrow::BorrowMut;
use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;

/// The main client for interacting with Clerk's Frontend API
#[derive(Clone)]
pub struct ClerkFapiClient {
    client: Arc<ClerkHttpClient>,
    config: ClerkFapiConfiguration,
    state: Arc<RwLock<ClerkState>>,
}

impl ClerkFapiClient {
    /// Creates a new ClerkFapiClient with the provided configuration
    pub fn new(
        config: ClerkFapiConfiguration,
        state: Arc<RwLock<ClerkState>>,
    ) -> Result<Self, String> {
        // Create default headers
        let mut headers = HeaderMap::new();
        if config.kind == ClientKind::NonBrowser {
            headers.insert("x-mobile", HeaderValue::from_static("1"));
            headers.insert("x-no-origin", HeaderValue::from_static("1"));
        }

        // Create client with default headers
        let http_client = Client::builder()
            .default_headers(headers)
            .user_agent(&config.user_agent)
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

        // Create custom client
        let client = ClerkHttpClient::new(http_client, state.clone(), config.kind);

        Ok(Self {
            client: Arc::new(client),
            config,
            state,
        })
    }

    fn clerk_config(&self) -> ApiConfiguration {
        self.config.into_api_configuration(self.client.clone())
    }

    pub fn set_dev_browser_token_id(&self, token_id: String) {
        self.client.set_dev_browser_token_id(token_id);
    }

    fn handle_client_update(&self, client: ClientClient) {
        let should_emit = self
            .state
            .read()
            .should_emit_client_change(client.clone())
            .unwrap_or(true);
        {
            // we anyways write the new state always
            // minimize write lock time
            let mut state = self.state.write();
            state.set_client(client);
        }
        // Emit only if needed
        if should_emit {
            let state = self.state.read();
            state.emit_state();
        }
    }

    // Active Sessions API methods
    pub async fn get_sessions(
        &self,
        clerk_session_id: Option<&str>,
    ) -> Result<Vec<ClientActiveSession>, Error<GetSessionsError>> {
        active_sessions_api::get_sessions(&self.clerk_config(), clerk_session_id).await
    }

    pub async fn get_users_sessions(
        &self,
        clerk_session_id: Option<&str>,
    ) -> Result<Vec<ClientSession>, Error<GetUsersSessionsError>> {
        active_sessions_api::get_users_sessions(&self.clerk_config(), clerk_session_id).await
    }

    pub async fn revoke_session(
        &self,
        session_id: &str,
        clerk_session_id: Option<&str>,
    ) -> Result<ClientSession, Error<RevokeSessionError>> {
        let response =
            active_sessions_api::revoke_session(&self.clerk_config(), session_id, clerk_session_id)
                .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    // Backup Codes API methods
    pub async fn create_backup_codes(&self) -> Result<BackupCodes, Error<CreateBackupCodesError>> {
        let response = backup_codes_api::create_backup_codes(&self.clerk_config()).await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Client API methods
    pub async fn delete_client_sessions(
        &self,
    ) -> Result<ClientDeleteSession, Error<DeleteClientSessionsError>> {
        let response = client_api::delete_client_sessions(&self.clerk_config()).await?;
        if let Some(client) = response.response.clone() {
            self.handle_client_update(*client);
        }
        Ok(response)
    }

    pub async fn get_client(&self) -> Result<Option<ClientClient>, Error<GetClientError>> {
        let response = client_api::get_client(&self.clerk_config()).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(response.response.map(|c| *c))
    }

    pub async fn handshake_client(
        &self,
        clerk_proxy_url: Option<&str>,
        clerk_secret_key: Option<&str>,
        redirect_url: Option<&str>,
        format: Option<&str>,
        organization_id: Option<&str>,
        satellite_fapi: Option<&str>,
    ) -> Result<(), Error<HandshakeClientError>> {
        client_api::handshake_client(
            &self.clerk_config(),
            clerk_proxy_url,
            clerk_secret_key,
            redirect_url,
            format,
            organization_id,
            satellite_fapi,
        )
        .await
    }

    pub async fn post_client(&self) -> Result<Option<ClientClient>, Error<PostClientError>> {
        let response = client_api::post_client(&self.clerk_config()).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(response.response.map(|c| *c))
    }

    pub async fn put_client(&self) -> Result<Option<ClientClient>, Error<PutClientError>> {
        let response = client_api::put_client(&self.clerk_config()).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(response.response.map(|c| *c))
    }

    // Default API methods
    pub async fn clear_site_data(&self) -> Result<(), Error<ClearSiteDataError>> {
        default_api::clear_site_data(&self.clerk_config()).await
    }

    pub async fn get_account_portal(
        &self,
    ) -> Result<ClientAccountPortal, Error<GetAccountPortalError>> {
        default_api::get_account_portal(&self.clerk_config()).await
    }

    pub async fn get_dev_browser_init(
        &self,
        origin: Option<&str>,
    ) -> Result<(), Error<GetDevBrowserInitError>> {
        default_api::get_dev_browser_init(&self.clerk_config(), origin).await
    }

    pub async fn get_proxy_health(
        &self,
        domain_id: &str,
        clerk_proxy_url: &str,
        clerk_secret_key: &str,
        x_forwarded_for: &str,
    ) -> Result<GetProxyHealth200Response, Error<GetProxyHealthError>> {
        default_api::get_proxy_health(
            &self.clerk_config(),
            domain_id,
            clerk_proxy_url,
            clerk_secret_key,
            x_forwarded_for,
        )
        .await
    }

    pub async fn link_client(
        &self,
        clerk_token: Option<&str>,
    ) -> Result<(), Error<LinkClientError>> {
        default_api::link_client(&self.clerk_config(), clerk_token).await
    }

    pub async fn post_dev_browser_init_set_cookie(
        &self,
    ) -> Result<(), Error<PostDevBrowserInitSetCookieError>> {
        default_api::post_dev_browser_init_set_cookie(&self.clerk_config()).await
    }

    pub async fn sync_client(
        &self,
        link_domain: Option<&str>,
        redirect_url: Option<&str>,
    ) -> Result<(), Error<SyncClientError>> {
        default_api::sync_client(&self.clerk_config(), link_domain, redirect_url).await
    }

    // Dev Browser API methods
    pub async fn create_dev_browser(&self) -> Result<DevBrowser, Error<CreateDevBrowserError>> {
        dev_browser_api::create_dev_browser(&self.clerk_config()).await
    }

    // Domains API methods
    pub async fn attempt_organization_domain_verification(
        &self,
        organization_id: &str,
        domain_id: &str,
        code: &str,
    ) -> Result<ClientOrganizationDomain, Error<AttemptOrganizationDomainVerificationError>> {
        let response = domains_api::attempt_organization_domain_verification(
            &self.clerk_config(),
            organization_id,
            domain_id,
            code,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn create_organization_domain(
        &self,
        organization_id: &str,
        name: &str,
    ) -> Result<ClientOrganizationDomain, Error<CreateOrganizationDomainError>> {
        let response =
            domains_api::create_organization_domain(&self.clerk_config(), organization_id, name)
                .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn delete_organization_domain(
        &self,
        organization_id: &str,
        domain_id: &str,
    ) -> Result<ClientDeletedObject, Error<DeleteOrganizationDomainError>> {
        let response = domains_api::delete_organization_domain(
            &self.clerk_config(),
            organization_id,
            domain_id,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn get_organization_domain(
        &self,
        organization_id: &str,
        domain_id: &str,
    ) -> Result<ClientOrganizationDomain, Error<domains_api::GetOrganizationDomainError>> {
        let response =
            domains_api::get_organization_domain(&self.clerk_config(), organization_id, domain_id)
                .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn list_organization_domains(
        &self,
        organization_id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
        verified: Option<bool>,
        enrollment_mode: Option<&str>,
    ) -> Result<ClientClientWrappedOrganizationDomainsResponse, Error<ListOrganizationDomainsError>>
    {
        let response = domains_api::list_organization_domains(
            &self.clerk_config(),
            organization_id,
            limit,
            offset,
            verified,
            enrollment_mode,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn prepare_organization_domain_verification(
        &self,
        organization_id: &str,
        domain_id: &str,
        affiliation_email_address: &str,
    ) -> Result<ClientOrganizationDomain, Error<PrepareOrganizationDomainVerificationError>> {
        let response = domains_api::prepare_organization_domain_verification(
            &self.clerk_config(),
            organization_id,
            domain_id,
            affiliation_email_address,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn update_organization_domain_enrollment_mode(
        &self,
        organization_id: &str,
        domain_id: &str,
        enrollment_mode: &str,
        delete_pending: Option<bool>,
    ) -> Result<ClientOrganizationDomain, Error<UpdateOrganizationDomainEnrollmentModeError>> {
        let response = domains_api::update_organization_domain_enrollment_mode(
            &self.clerk_config(),
            organization_id,
            domain_id,
            enrollment_mode,
            delete_pending,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Email Addresses API methods
    pub async fn create_email_addresses(
        &self,
        email_address: &str,
        _clerk_session_id: Option<&str>,
    ) -> Result<ClientEmailAddress, Error<CreateEmailAddressesError>> {
        let response = email_addresses_api::create_email_addresses(
            &self.clerk_config(),
            email_address,
            _clerk_session_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn delete_email_address(
        &self,
        email_id: &str,
        clerk_session_id: Option<&str>,
    ) -> Result<ClientDeletedObject, Error<DeleteEmailAddressError>> {
        let response = email_addresses_api::delete_email_address(
            &self.clerk_config(),
            email_id,
            clerk_session_id,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn get_email_address(
        &self,
        email_id: &str,
        clerk_session_id: Option<&str>,
    ) -> Result<ClientEmailAddress, Error<GetEmailAddressError>> {
        let response = email_addresses_api::get_email_address(
            &self.clerk_config(),
            email_id,
            clerk_session_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn get_email_addresses(
        &self,
        clerk_session_id: Option<&str>,
    ) -> Result<Vec<ClientEmailAddress>, Error<GetEmailAddressesError>> {
        email_addresses_api::get_email_addresses(&self.clerk_config(), clerk_session_id).await
    }

    pub async fn send_verification_email(
        &self,
        email_id: &str,
        strategy: &str,
        _clerk_session_id: Option<&str>,
        redirect_url: Option<&str>,
        action_complete_redirect_url: Option<&str>,
    ) -> Result<ClientEmailAddress, Error<SendVerificationEmailError>> {
        let response = email_addresses_api::send_verification_email(
            &self.clerk_config(),
            email_id,
            strategy,
            _clerk_session_id,
            redirect_url,
            action_complete_redirect_url,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn verify_email_address(
        &self,
        email_id: &str,
        code: &str,
        _clerk_session_id: Option<&str>,
    ) -> Result<ClientEmailAddress, Error<VerifyEmailAddressError>> {
        let response = email_addresses_api::verify_email_address(
            &self.clerk_config(),
            email_id,
            code,
            _clerk_session_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Environment API methods
    pub async fn get_environment(&self) -> Result<ClientEnvironment, Error<GetEnvironmentError>> {
        environment_api::get_environment(&self.clerk_config()).await
    }

    pub async fn update_environment(
        &self,
        origin: &str,
    ) -> Result<ClientEnvironment, Error<UpdateEnvironmentError>> {
        environment_api::update_environment(&self.clerk_config(), origin).await
    }

    // External Accounts API methods
    pub async fn delete_external_account(
        &self,
        external_account_id: &str,
    ) -> Result<ClientDeletedObject, Error<DeleteExternalAccountError>> {
        let response = external_accounts_api::delete_external_account(
            &self.clerk_config(),
            external_account_id,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn post_o_auth_accounts(
        &self,
        strategy: &str,
        origin: Option<&str>,
        redirect_url: Option<&str>,
        action_complete_redirect_url: Option<&str>,
        additional_scope: Option<&str>,
        code: Option<&str>,
        token: Option<&str>,
        oidc_login_hint: Option<&str>,
        oidc_prompt: Option<&str>,
    ) -> Result<ExternalAccountWithVerification, Error<PostOAuthAccountsError>> {
        let response = external_accounts_api::post_o_auth_accounts(
            &self.clerk_config(),
            strategy,
            origin,
            redirect_url,
            action_complete_redirect_url,
            additional_scope,
            code,
            token,
            oidc_login_hint,
            oidc_prompt,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(response.response)
    }

    pub async fn reauthorize_external_account(
        &self,
        external_account_id: &str,
        redirect_url: &str,
        additional_scope: Option<Vec<String>>,
        action_complete_redirect_url: Option<&str>,
        oidc_login_hint: Option<&str>,
        oidc_prompt: Option<&str>,
    ) -> Result<ExternalAccountWithVerification, Error<ReauthorizeExternalAccountError>> {
        let response = external_accounts_api::reauthorize_external_account(
            &self.clerk_config(),
            external_account_id,
            redirect_url,
            additional_scope,
            action_complete_redirect_url,
            oidc_login_hint,
            oidc_prompt,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(response.response)
    }

    pub async fn revoke_external_account_tokens(
        &self,
        external_account_id: &str,
    ) -> Result<ClientUser, Error<RevokeExternalAccountTokensError>> {
        let response = external_accounts_api::revoke_external_account_tokens(
            &self.clerk_config(),
            external_account_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Health API methods
    pub async fn get_health(&self) -> Result<GetHealth200Response, Error<GetHealthError>> {
        health_api::get_health(&self.clerk_config()).await
    }

    // Invitations API methods
    pub async fn bulk_create_organization_invitations(
        &self,
        organization_id: &str,
        email_address: Vec<String>,
        role: &str,
    ) -> Result<Vec<ClientOrganizationInvitation>, Error<BulkCreateOrganizationInvitationsError>>
    {
        let response = invitations_api::bulk_create_organization_invitations(
            &self.clerk_config(),
            organization_id,
            email_address,
            role,
        )
        .await?;
        self.handle_client_update(*response.client.clone());

        let res = match *response.response {
            ClientClientWrappedOrganizationInvitationsResponse::ArrayVecmodelsClientOrganizationInvitation(res) => res,
            ClientClientWrappedOrganizationInvitationsResponse::ClientClientWrappedOrganizationInvitationsResponseOneOf(res) => {
                res.data.unwrap_or(Vec::new())
            }
        };

        Ok(res)
    }

    pub async fn create_organization_invitations(
        &self,
        organization_id: &str,
        email_address: &str,
        role: &str,
    ) -> Result<ClientOrganizationInvitation, Error<CreateOrganizationInvitationsError>> {
        let response = invitations_api::create_organization_invitations(
            &self.clerk_config(),
            organization_id,
            email_address,
            role,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn get_all_pending_organization_invitations(
        &self,
        organization_id: &str,
    ) -> Result<Vec<ClientOrganizationInvitation>, Error<GetAllPendingOrganizationInvitationsError>>
    {
        let response = invitations_api::get_all_pending_organization_invitations(
            &self.clerk_config(),
            organization_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        let res = match *response.response {
            ClientClientWrappedOrganizationInvitationsResponse::ArrayVecmodelsClientOrganizationInvitation(res) => res,
            ClientClientWrappedOrganizationInvitationsResponse::ClientClientWrappedOrganizationInvitationsResponseOneOf(res) => {
                res.data.unwrap_or(Vec::new())
            }
        };
        Ok(res)
    }

    pub async fn get_organization_invitations(
        &self,
        organization_id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
        status: Option<&str>,
    ) -> Result<Vec<ClientOrganizationInvitation>, Error<GetOrganizationInvitationsError>> {
        let response = invitations_api::get_organization_invitations(
            &self.clerk_config(),
            organization_id,
            limit,
            offset,
            status,
        )
        .await?;
        self.handle_client_update(*response.client.clone());

        let res = match *response.response {
            ClientClientWrappedOrganizationInvitationsResponse::ArrayVecmodelsClientOrganizationInvitation(res) => res,
            ClientClientWrappedOrganizationInvitationsResponse::ClientClientWrappedOrganizationInvitationsResponseOneOf(res) => {
                res.data.unwrap_or(Vec::new())
            }
        };
        Ok(res)
    }

    pub async fn revoke_pending_organization_invitation(
        &self,
        organization_id: &str,
        invitation_id: &str,
    ) -> Result<ClientOrganizationInvitation, Error<RevokePendingOrganizationInvitationError>> {
        let response = invitations_api::revoke_pending_organization_invitation(
            &self.clerk_config(),
            organization_id,
            invitation_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Members API methods
    pub async fn create_organization_membership(
        &self,
        organization_id: &str,
        user_id: Option<&str>,
        role: Option<&str>,
    ) -> Result<ClientOrganizationMembership, Error<CreateOrganizationMembershipError>> {
        let response = members_api::create_organization_membership(
            &self.clerk_config(),
            organization_id,
            user_id,
            role,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn list_organization_memberships(
        &self,
        organization_id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
        paginated: Option<bool>,
        query: Option<&str>,
        role: Option<&str>,
    ) -> Result<Vec<ClientOrganizationMembership>, Error<ListOrganizationMembershipsError>> {
        let response = members_api::list_organization_memberships(
            &self.clerk_config(),
            organization_id,
            limit,
            offset,
            paginated,
            query,
            role,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        let res = match *response.response {
            ClientClientWrappedOrganizationMembershipsResponse::ArrayVecmodelsClientOrganizationMembership(res) => res,
            ClientClientWrappedOrganizationMembershipsResponse::ClientClientWrappedOrganizationMembershipsResponseOneOf(res) => {
                res.data.unwrap_or(Vec::new())
            }
        };
        Ok(res)
    }

    pub async fn remove_organization_member(
        &self,
        organization_id: &str,
        user_id: &str,
    ) -> Result<ClientOrganizationMembership, Error<RemoveOrganizationMemberError>> {
        let response =
            members_api::remove_organization_member(&self.clerk_config(), organization_id, user_id)
                .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn update_organization_membership(
        &self,
        organization_id: &str,
        user_id: &str,
        role: Option<&str>,
    ) -> Result<ClientOrganizationMembership, Error<UpdateOrganizationMembershipError>> {
        let response = members_api::update_organization_membership(
            &self.clerk_config(),
            organization_id,
            user_id,
            role,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Membership Requests API methods
    pub async fn accept_organization_membership_request(
        &self,
        organization_id: &str,
        request_id: &str,
    ) -> Result<ClientOrganizationMembershipRequest, Error<AcceptOrganizationMembershipRequestError>>
    {
        let response = membership_requests_api::accept_organization_membership_request(
            &self.clerk_config(),
            organization_id,
            request_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn list_organization_membership_requests(
        &self,
        organization_id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
        status: Option<&str>,
    ) -> Result<
        ClientClientWrappedOrganizationMembershipRequestsResponse,
        Error<ListOrganizationMembershipRequestsError>,
    > {
        let response = membership_requests_api::list_organization_membership_requests(
            &self.clerk_config(),
            organization_id,
            limit,
            offset,
            status,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn reject_organization_membership_request(
        &self,
        organization_id: &str,
        request_id: &str,
    ) -> Result<ClientOrganizationMembershipRequest, Error<RejectOrganizationMembershipRequestError>>
    {
        let response = membership_requests_api::reject_organization_membership_request(
            &self.clerk_config(),
            organization_id,
            request_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // OAuth2 Callbacks API methods
    pub async fn get_oauth_callback(
        &self,
        scope: Option<&str>,
        code: Option<&str>,
        state: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), Error<GetOauthCallbackError>> {
        o_auth2_callbacks_api::get_oauth_callback(&self.clerk_config(), scope, code, state, error)
            .await
    }

    pub async fn post_oauth_callback(
        &self,
        code: Option<&str>,
        scope: Option<&str>,
        state: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), Error<PostOauthCallbackError>> {
        o_auth2_callbacks_api::post_oauth_callback(&self.clerk_config(), code, scope, state, error)
            .await
    }

    // OAuth2 Identity Provider API methods
    pub async fn get_o_auth_consent(
        configuration: &configuration::Configuration,
        client_id: &str,
        _clerk_session_id: Option<&str>,
    ) -> Result<OAuthConsentInfo, Error<GetOAuthConsentError>> {
        o_auth2_identify_provider_api::get_o_auth_consent(
            configuration,
            client_id,
            _clerk_session_id,
        )
        .await
    }

    pub async fn get_o_auth_token(&self) -> Result<OAuthToken, Error<GetOAuthTokenError>> {
        o_auth2_identify_provider_api::get_o_auth_token(&self.clerk_config()).await
    }

    pub async fn get_o_auth_token_info(
        &self,
        token: &str,
        token_type_hint: Option<&str>,
        scope: Option<&str>,
    ) -> Result<OAuthTokenInfo, Error<GetOAuthTokenInfoError>> {
        o_auth2_identify_provider_api::get_o_auth_token_info(
            &self.clerk_config(),
            token,
            token_type_hint,
            scope,
        )
        .await
    }

    pub async fn get_o_auth_user_info(
        &self,
    ) -> Result<OAuthUserInfo, Error<GetOAuthUserInfoError>> {
        o_auth2_identify_provider_api::get_o_auth_user_info(&self.clerk_config()).await
    }

    pub async fn get_o_auth_user_info_post(
        &self,
    ) -> Result<OAuthUserInfo, Error<GetOAuthUserInfoPostError>> {
        o_auth2_identify_provider_api::get_o_auth_user_info_post(&self.clerk_config()).await
    }

    pub async fn request_o_auth_authorize(&self) -> Result<(), Error<RequestOAuthAuthorizeError>> {
        o_auth2_identify_provider_api::request_o_auth_authorize(&self.clerk_config()).await
    }

    pub async fn request_o_auth_authorize_post(
        &self,
    ) -> Result<(), Error<RequestOAuthAuthorizePostError>> {
        o_auth2_identify_provider_api::request_o_auth_authorize_post(&self.clerk_config()).await
    }

    pub async fn revoke_o_auth_token(
        &self,
        token: Option<&str>,
        token_type_hint: Option<&str>,
    ) -> Result<(), Error<RevokeOAuthTokenError>> {
        o_auth2_identify_provider_api::revoke_o_auth_token(
            &self.clerk_config(),
            token,
            token_type_hint,
        )
        .await
    }

    // Organization API methods
    pub async fn create_organization(
        &self,
        name: Option<&str>,
    ) -> Result<ClientOrganization, Error<CreateOrganizationError>> {
        let response = organization_api::create_organization(&self.clerk_config(), name).await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn delete_organization(
        &self,
        organization_id: &str,
    ) -> Result<ClientDeletedObject, Error<DeleteOrganizationError>> {
        let response =
            organization_api::delete_organization(&self.clerk_config(), organization_id).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn delete_organization_logo(
        &self,
        organization_id: &str,
    ) -> Result<ClientDeletedObject, Error<DeleteOrganizationLogoError>> {
        let response =
            organization_api::delete_organization_logo(&self.clerk_config(), organization_id)
                .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn get_organization(
        &self,
        organization_id: &str,
    ) -> Result<ClientOrganization, Error<GetOrganizationError>> {
        let response =
            organization_api::get_organization(&self.clerk_config(), organization_id).await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn update_organization(
        &self,
        organization_id: &str,
        name: Option<&str>,
        slug: Option<&str>,
    ) -> Result<ClientOrganization, Error<UpdateOrganizationError>> {
        let response = organization_api::update_organization(
            &self.clerk_config(),
            organization_id,
            name,
            slug,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn update_organization_logo(
        &self,
        organization_id: &str,
        file: FileData,
    ) -> Result<ClientOrganization, Error<UpdateOrganizationLogoError>> {
        let response =
            organization_api::update_organization_logo(&self.clerk_config(), organization_id, file)
                .await?;
        self.handle_client_update((*response.client.clone()).into());
        Ok(*response.response)
    }

    // Organization Memberships API methods
    pub async fn accept_organization_invitation(
        &self,
        invitation_id: &str,
    ) -> Result<ClientOrganizationInvitationUserContext, Error<AcceptOrganizationInvitationError>>
    {
        let response = organizations_memberships_api::accept_organization_invitation(
            &self.clerk_config(),
            invitation_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn accept_organization_suggestion(
        &self,
        suggestion_id: &str,
    ) -> Result<ClientOrganizationSuggestion, Error<AcceptOrganizationSuggestionError>> {
        let response = organizations_memberships_api::accept_organization_suggestion(
            &self.clerk_config(),
            suggestion_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn delete_organization_memberships(
        &self,
        organization_id: &str,
    ) -> Result<ClientDeletedObject, Error<DeleteOrganizationMembershipsError>> {
        let response = organizations_memberships_api::delete_organization_memberships(
            &self.clerk_config(),
            organization_id,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn get_organization_memberships(
        &self,
        limit: Option<i64>,
        offset: Option<i64>,
        paginated: Option<bool>,
    ) -> Result<Vec<ClientOrganizationMembership>, Error<GetOrganizationMembershipsError>> {
        let response = organizations_memberships_api::get_organization_memberships(
            &self.clerk_config(),
            limit,
            offset,
            paginated,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        let res = match *response.response {
            ClientClientWrappedOrganizationMembershipsResponse::ArrayVecmodelsClientOrganizationMembership(res) => res,
            ClientClientWrappedOrganizationMembershipsResponse::ClientClientWrappedOrganizationMembershipsResponseOneOf(res) => {
                res.data.unwrap_or(Vec::new())
            }
        };
        Ok(res)
    }

    pub async fn get_organization_suggestions(
        &self,
        limit: Option<i64>,
        offset: Option<i64>,
        status: Option<&str>,
    ) -> Result<
        ClientClientWrappedOrganizationSuggestionsResponse,
        Error<GetOrganizationSuggestionsError>,
    > {
        let response = organizations_memberships_api::get_organization_suggestions(
            &self.clerk_config(),
            limit,
            offset,
            status,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn get_users_organization_invitations(
        &self,
        limit: Option<i64>,
        offset: Option<i64>,
        status: Option<&str>,
    ) -> Result<
        ClientClientWrappedOrganizationInvitationsUserContextResponse,
        Error<GetUsersOrganizationInvitationsError>,
    > {
        let response = organizations_memberships_api::get_users_organization_invitations(
            &self.clerk_config(),
            limit,
            offset,
            status,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Passkeys API methods
    pub async fn attempt_passkey_verification(
        &self,
        passkey_id: &str,
        origin: Option<&str>,
        strategy: Option<&str>,
        public_key_credential: Option<&str>,
    ) -> Result<ClientPasskey, Error<AttemptPasskeyVerificationError>> {
        let response = passkeys_api::attempt_passkey_verification(
            &self.clerk_config(),
            passkey_id,
            origin,
            strategy,
            public_key_credential,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn delete_passkey(
        &self,
        passkey_id: &str,
    ) -> Result<ClientDeletedObject, Error<DeletePasskeyError>> {
        let response = passkeys_api::delete_passkey(&self.clerk_config(), passkey_id).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn patch_passkey(
        &self,
        passkey_id: &str,
        name: Option<&str>,
    ) -> Result<ClientPasskey, Error<PatchPasskeyError>> {
        let response = passkeys_api::patch_passkey(&self.clerk_config(), passkey_id, name).await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn post_passkey(
        &self,
        _clerk_session_id: Option<&str>,
        origin: Option<&str>,
        x_original_host: Option<&str>,
    ) -> Result<ClientPasskey, Error<PostPasskeyError>> {
        let response = passkeys_api::post_passkey(
            &self.clerk_config(),
            _clerk_session_id,
            origin,
            x_original_host,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn read_passkey(
        &self,
        passkey_id: &str,
    ) -> Result<ClientPasskey, Error<ReadPasskeyError>> {
        let response = passkeys_api::read_passkey(&self.clerk_config(), passkey_id).await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Phone Numbers API methods
    pub async fn delete_phone_number(
        &self,
        phone_number_id: &str,
        clerk_session_id: Option<&str>,
    ) -> Result<ClientDeletedObject, Error<DeletePhoneNumberError>> {
        let response = phone_numbers_api::delete_phone_number(
            &self.clerk_config(),
            phone_number_id,
            clerk_session_id,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn get_phone_numbers(
        &self,
        clerk_session_id: Option<&str>,
    ) -> Result<Vec<ClientPhoneNumber>, Error<GetPhoneNumbersError>> {
        phone_numbers_api::get_phone_numbers(&self.clerk_config(), clerk_session_id).await
    }

    pub async fn post_phone_numbers(
        &self,
        phone_number: &str,
        _clerk_session_id: Option<&str>,
        reserved_for_second_factor: Option<bool>,
    ) -> Result<ClientPhoneNumber, Error<PostPhoneNumbersError>> {
        let response = phone_numbers_api::post_phone_numbers(
            &self.clerk_config(),
            phone_number,
            _clerk_session_id,
            reserved_for_second_factor,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn read_phone_number(
        &self,
        phone_number_id: &str,
        clerk_session_id: Option<&str>,
    ) -> Result<ClientPhoneNumber, Error<ReadPhoneNumberError>> {
        let response = phone_numbers_api::read_phone_number(
            &self.clerk_config(),
            phone_number_id,
            clerk_session_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn send_verification_sms(
        &self,
        phone_number_id: &str,
        strategy: &str,
        _clerk_session_id: Option<&str>,
    ) -> Result<ClientPhoneNumber, Error<SendVerificationSmsError>> {
        let response = phone_numbers_api::send_verification_sms(
            &self.clerk_config(),
            phone_number_id,
            strategy,
            _clerk_session_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn update_phone_number(
        &self,
        phone_number_id: &str,
        clerk_session_id: Option<&str>,
        reserved_for_second_factor: Option<bool>,
        default_second_factor: Option<bool>,
    ) -> Result<ClientPhoneNumber, Error<UpdatePhoneNumberError>> {
        let response = phone_numbers_api::update_phone_number(
            &self.clerk_config(),
            phone_number_id,
            clerk_session_id,
            reserved_for_second_factor,
            default_second_factor,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn verify_phone_number(
        &self,
        phone_number_id: &str,
        code: &str,
        _clerk_session_id: Option<&str>,
    ) -> Result<ClientPhoneNumber, Error<VerifyPhoneNumberError>> {
        let response = phone_numbers_api::verify_phone_number(
            &self.clerk_config(),
            phone_number_id,
            code,
            _clerk_session_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Redirect API methods
    pub async fn redirect_to_url(
        &self,
        redirect_url: Option<&str>,
    ) -> Result<(), Error<RedirectToUrlError>> {
        redirect_api::redirect_to_url(&self.clerk_config(), redirect_url).await
    }

    // Roles API methods
    pub async fn list_organization_roles(
        &self,
        organization_id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<ClientClientWrappedRolesResponse, Error<ListOrganizationRolesError>> {
        let response = roles_api::list_organization_roles(
            &self.clerk_config(),
            organization_id,
            limit,
            offset,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // SAML API methods
    pub async fn acs(&self, saml_connection_id: &str) -> Result<(), Error<AcsError>> {
        saml_api::acs(&self.clerk_config(), saml_connection_id).await
    }

    pub async fn saml_metadata(
        &self,
        saml_connection_id: &str,
    ) -> Result<(), Error<SamlMetadataError>> {
        saml_api::saml_metadata(&self.clerk_config(), saml_connection_id).await
    }

    // Sessions API methods
    pub async fn attempt_session_reverification_first_factor(
        &self,
        session_id: &str,
        strategy: &str,
        origin: Option<&str>,
        code: Option<&str>,
        password: Option<&str>,
        public_key_credential: Option<&str>,
    ) -> Result<ClientSessionReverification, Error<AttemptSessionReverificationFirstFactorError>>
    {
        let response = sessions_api::attempt_session_reverification_first_factor(
            &self.clerk_config(),
            session_id,
            strategy,
            origin,
            code,
            password,
            public_key_credential,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    pub async fn attempt_session_reverification_second_factor(
        &self,
        session_id: &str,
        strategy: Option<&str>,
        code: Option<&str>,
    ) -> Result<ClientSessionReverification, Error<AttemptSessionReverificationSecondFactorError>>
    {
        let response = sessions_api::attempt_session_reverification_second_factor(
            &self.clerk_config(),
            session_id,
            strategy,
            code,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    pub async fn create_session_token(
        &self,
        session_id: &str,
        organization_id: Option<&str>,
    ) -> Result<CreateSessionToken200Response, Error<CreateSessionTokenError>> {
        sessions_api::create_session_token(&self.clerk_config(), session_id, organization_id).await
    }

    pub async fn create_session_token_with_template(
        &self,
        session_id: &str,
        template_name: &str,
    ) -> Result<CreateSessionToken200Response, Error<CreateSessionTokenWithTemplateError>> {
        sessions_api::create_session_token_with_template(
            &self.clerk_config(),
            session_id,
            template_name,
        )
        .await
    }

    pub async fn end_session(
        &self,
        session_id: &str,
    ) -> Result<ClientSession, Error<EndSessionError>> {
        let response = sessions_api::end_session(&self.clerk_config(), session_id).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    pub async fn get_session(
        &self,
        session_id: &str,
    ) -> Result<ClientSession, Error<GetSessionError>> {
        let response = sessions_api::get_session(&self.clerk_config(), session_id).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    pub async fn prepare_session_reverification_first_factor(
        &self,
        session_id: &str,
        origin: Option<&str>,
        strategy: Option<&str>,
        email_address_id: Option<&str>,
        phone_number_id: Option<&str>,
    ) -> Result<ClientSessionReverification, Error<PrepareSessionReverificationFirstFactorError>>
    {
        let response = sessions_api::prepare_session_reverification_first_factor(
            &self.clerk_config(),
            session_id,
            origin,
            strategy,
            email_address_id,
            phone_number_id,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    pub async fn prepare_session_reverification_second_factor(
        &self,
        session_id: &str,
        strategy: Option<&str>,
        phone_number_id: Option<&str>,
    ) -> Result<ClientSessionReverification, Error<PrepareSessionReverificationSecondFactorError>>
    {
        let response = sessions_api::prepare_session_reverification_second_factor(
            &self.clerk_config(),
            session_id,
            strategy,
            phone_number_id,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    pub async fn remove_client_sessions_and_retain_cookie(
        &self,
    ) -> Result<Option<ClientClient>, Error<RemoveClientSessionsAndRetainCookieError>> {
        let response =
            sessions_api::remove_client_sessions_and_retain_cookie(&self.clerk_config()).await?;
        if let Some(client) = response.response.clone() {
            self.handle_client_update(*client);
        }
        Ok(response.response.map(|s| *s))
    }

    pub async fn remove_session(
        &self,
        session_id: &str,
    ) -> Result<ClientSession, Error<RemoveSessionError>> {
        let response = sessions_api::remove_session(&self.clerk_config(), session_id).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    pub async fn start_session_reverification(
        &self,
        session_id: &str,
        level: &str,
    ) -> Result<ClientSessionReverification, Error<StartSessionReverificationError>> {
        let response =
            sessions_api::start_session_reverification(&self.clerk_config(), session_id, level)
                .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    pub async fn touch_session(
        &self,
        session_id: &str,
        active_organization_id: Option<&str>,
    ) -> Result<ClientSession, Error<TouchSessionError>> {
        let response =
            sessions_api::touch_session(&self.clerk_config(), session_id, active_organization_id)
                .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    // Sign Ins API methods
    pub async fn accept_ticket(
        &self,
        ticket: &str,
    ) -> Result<(), Error<sign_ins_api::AcceptTicketError>> {
        sign_ins_api::accept_ticket(&self.clerk_config(), ticket).await
    }

    pub async fn attempt_sign_in_factor_one(
        &self,
        sign_in_id: &str,
        strategy: &str,
        origin: Option<&str>,
        code: Option<&str>,
        password: Option<&str>,
        signature: Option<&str>,
        token: Option<&str>,
        ticket: Option<&str>,
        public_key_credential: Option<&str>,
    ) -> Result<ClientSignIn, Error<AttemptSignInFactorOneError>> {
        let response = sign_ins_api::attempt_sign_in_factor_one(
            &self.clerk_config(),
            sign_in_id,
            strategy,
            origin,
            code,
            password,
            signature,
            token,
            ticket,
            public_key_credential,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        }
        Ok(*response.response)
    }

    pub async fn attempt_sign_in_factor_two(
        &self,
        sign_in_id: &str,
        strategy: Option<&str>,
        code: Option<&str>,
    ) -> Result<ClientSignIn, Error<AttemptSignInFactorTwoError>> {
        let response = sign_ins_api::attempt_sign_in_factor_two(
            &self.clerk_config(),
            sign_in_id,
            strategy,
            code,
        )
        .await?;

        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    pub async fn create_sign_in(
        &self,
        origin: Option<&str>,
        strategy: Option<&str>,
        identifier: Option<&str>,
        password: Option<&str>,
        ticket: Option<&str>,
        redirect_url: Option<&str>,
        action_complete_redirect_url: Option<&str>,
        transfer: Option<bool>,
        code: Option<&str>,
        token: Option<&str>,
        oidc_login_hint: Option<&str>,
        oidc_prompt: Option<&str>,
    ) -> Result<ClientSignIn, Error<CreateSignInError>> {
        let response = sign_ins_api::create_sign_in(
            &self.clerk_config(),
            origin,
            strategy,
            identifier,
            password,
            ticket,
            redirect_url,
            action_complete_redirect_url,
            transfer,
            code,
            token,
            oidc_login_hint,
            oidc_prompt,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    pub async fn get_sign_in(
        &self,
        sign_in_id: &str,
    ) -> Result<ClientSignIn, Error<GetSignInError>> {
        let response = sign_ins_api::get_sign_in(&self.clerk_config(), sign_in_id).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    pub async fn prepare_sign_in_factor_one(
        &self,
        sign_in_id: &str,
        strategy: &str,
        origin: Option<&str>,
        email_address_id: Option<&str>,
        phone_number_id: Option<&str>,
        web3_wallet_id: Option<&str>,
        passkey_id: Option<&str>,
        redirect_url: Option<&str>,
        action_complete_redirect_url: Option<&str>,
        oidc_login_hint: Option<&str>,
        oidc_prompt: Option<&str>,
    ) -> Result<ClientSignIn, Error<PrepareSignInFactorOneError>> {
        let response = sign_ins_api::prepare_sign_in_factor_one(
            &self.clerk_config(),
            sign_in_id,
            strategy,
            origin,
            email_address_id,
            phone_number_id,
            web3_wallet_id,
            passkey_id,
            redirect_url,
            action_complete_redirect_url,
            oidc_login_hint,
            oidc_prompt,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    pub async fn prepare_sign_in_factor_two(
        &self,
        sign_in_id: &str,
        strategy: Option<&str>,
        phone_number_id: Option<&str>,
    ) -> Result<ClientSignIn, Error<PrepareSignInFactorTwoError>> {
        let response = sign_ins_api::prepare_sign_in_factor_two(
            &self.clerk_config(),
            sign_in_id,
            strategy,
            phone_number_id,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    pub async fn reset_password(
        &self,
        sign_in_id: &str,
        password: &str,
        sign_out_of_other_sessions: Option<bool>,
    ) -> Result<ClientSignIn, Error<ResetPasswordError>> {
        let response = sign_ins_api::reset_password(
            &self.clerk_config(),
            sign_in_id,
            password,
            sign_out_of_other_sessions,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update((*client).into());
        };
        Ok(*response.response)
    }

    pub async fn verify(&self, token: &str) -> Result<(), Error<VerifyError>> {
        sign_ins_api::verify(&self.clerk_config(), token).await
    }

    // Sign Ups API methods
    pub async fn attempt_sign_ups_verification(
        &self,
        sign_up_id: &str,
        origin: Option<&str>,
        strategy: Option<&str>,
        code: Option<&str>,
        signature: Option<&str>,
        token: Option<&str>,
    ) -> Result<ClientSignUp, Error<AttemptSignUpsVerificationError>> {
        let response = sign_ups_api::attempt_sign_ups_verification(
            &self.clerk_config(),
            sign_up_id,
            origin,
            strategy,
            code,
            signature,
            token,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    pub async fn create_sign_ups(
        &self,
        origin: Option<&str>,
        transfer: Option<bool>,
        password: Option<&str>,
        first_name: Option<&str>,
        last_name: Option<&str>,
        username: Option<&str>,
        email_address: Option<&str>,
        phone_number: Option<&str>,
        email_address_or_phone_number: Option<&str>,
        unsafe_metadata: Option<&str>,
        strategy: Option<&str>,
        action_complete_redirect_url: Option<&str>,
        redirect_url: Option<&str>,
        ticket: Option<&str>,
        web3_wallet: Option<&str>,
        token: Option<&str>,
        code: Option<&str>,
        captcha_token: Option<&str>,
        captcha_error: Option<&str>,
        captcha_widget_type: Option<&str>,
        legal_accepted: Option<bool>,
        oidc_login_hint: Option<&str>,
        oidc_prompt: Option<&str>,
    ) -> Result<ClientSignUp, Error<CreateSignUpsError>> {
        let response = sign_ups_api::create_sign_ups(
            &self.clerk_config(),
            origin,
            transfer,
            password,
            first_name,
            last_name,
            username,
            email_address,
            phone_number,
            email_address_or_phone_number,
            unsafe_metadata,
            strategy,
            action_complete_redirect_url,
            redirect_url,
            ticket,
            web3_wallet,
            token,
            code,
            captcha_token,
            captcha_error,
            captcha_widget_type,
            legal_accepted,
            oidc_login_hint,
            oidc_prompt,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    pub async fn get_sign_ups(
        &self,
        sign_up_id: &str,
    ) -> Result<ClientSignUp, Error<GetSignUpsError>> {
        let response = sign_ups_api::get_sign_ups(&self.clerk_config(), sign_up_id).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    pub async fn prepare_sign_ups_verification(
        &self,
        sign_up_id: &str,
        origin: Option<&str>,
        strategy: Option<&str>,
        redirect_url: Option<&str>,
        action_complete_redirect_url: Option<&str>,
        oidc_login_hint: Option<&str>,
        oidc_prompt: Option<&str>,
    ) -> Result<ClientSignUp, Error<PrepareSignUpsVerificationError>> {
        let response = sign_ups_api::prepare_sign_ups_verification(
            &self.clerk_config(),
            sign_up_id,
            origin,
            strategy,
            redirect_url,
            action_complete_redirect_url,
            oidc_login_hint,
            oidc_prompt,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    pub async fn update_sign_ups(
        &self,
        sign_up_id: &str,
        origin: Option<&str>,
        password: Option<&str>,
        first_name: Option<&str>,
        last_name: Option<&str>,
        username: Option<&str>,
        email_address: Option<&str>,
        phone_number: Option<&str>,
        email_address_or_phone_number: Option<&str>,
        unsafe_metadata: Option<&str>,
        strategy: Option<&str>,
        redirect_url: Option<&str>,
        action_complete_redirect_url: Option<&str>,
        ticket: Option<&str>,
        web3_wallet: Option<&str>,
        token: Option<&str>,
        code: Option<&str>,
        legal_accepted: Option<bool>,
        oidc_login_hint: Option<&str>,
        oidc_prompt: Option<&str>,
    ) -> Result<ClientSignUp, Error<UpdateSignUpsError>> {
        let response = sign_ups_api::update_sign_ups(
            &self.clerk_config(),
            sign_up_id,
            origin,
            password,
            first_name,
            last_name,
            username,
            email_address,
            phone_number,
            email_address_or_phone_number,
            unsafe_metadata,
            strategy,
            redirect_url,
            action_complete_redirect_url,
            ticket,
            web3_wallet,
            token,
            code,
            legal_accepted,
            oidc_login_hint,
            oidc_prompt,
        )
        .await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client);
        };
        Ok(*response.response)
    }

    // TOTP API methods
    pub async fn delete_totp(&self) -> Result<ClientDeletedObject, Error<DeleteTotpError>> {
        let response = totp_api::delete_totp(&self.clerk_config()).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn post_totp(&self) -> Result<Totp, Error<PostTotpError>> {
        let response = totp_api::post_totp(&self.clerk_config()).await?;
        self.handle_client_update(*response.client.clone());
        Ok(response.response)
    }

    pub async fn verify_totp(&self, code: Option<&str>) -> Result<Totp, Error<VerifyTotpError>> {
        let response = totp_api::verify_totp(&self.clerk_config(), code).await?;
        self.handle_client_update(*response.client.clone());
        Ok(response.response)
    }

    // User API methods
    pub async fn change_password(
        &self,
        current_password: Option<&str>,
        new_password: Option<&str>,
        sign_out_of_other_sessions: Option<bool>,
    ) -> Result<ClientUser, Error<ChangePasswordError>> {
        let response = user_api::change_password(
            &self.clerk_config(),
            current_password,
            new_password,
            sign_out_of_other_sessions,
        )
        .await?;
        self.handle_client_update((*response.client.clone()).into());
        Ok(*response.response)
    }

    pub async fn create_service_token(
        &self,
        service: &str,
        _clerk_session_id: Option<&str>,
    ) -> Result<Token, Error<CreateServiceTokenError>> {
        user_api::create_service_token(&self.clerk_config(), service, _clerk_session_id).await
    }

    pub async fn delete_profile_image(
        &self,
    ) -> Result<ClientDeletedObject, Error<DeleteProfileImageError>> {
        let response = user_api::delete_profile_image(&self.clerk_config()).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn delete_user(&self) -> Result<ClientDeletedObject, Error<DeleteUserError>> {
        let response = user_api::delete_user(&self.clerk_config()).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn get_user(&self) -> Result<ClientUser, Error<GetUserError>> {
        let response = user_api::get_user(&self.clerk_config()).await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn patch_user(
        &self,
        username: Option<&str>,
        first_name: Option<&str>,
        last_name: Option<&str>,
        primary_email_address_id: Option<&str>,
        primary_phone_number_id: Option<&str>,
        primary_web3_wallet_id: Option<&str>,
        unsafe_metadata: Option<&str>,
    ) -> Result<ClientUser, Error<PatchUserError>> {
        let response = user_api::patch_user(
            &self.clerk_config(),
            username,
            first_name,
            last_name,
            primary_email_address_id,
            primary_phone_number_id,
            primary_web3_wallet_id,
            unsafe_metadata,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn remove_password(
        &self,
        current_password: Option<&str>,
    ) -> Result<ClientUser, Error<RemovePasswordError>> {
        let response = user_api::remove_password(&self.clerk_config(), current_password).await?;
        self.handle_client_update((*response.client.clone()).into());
        Ok(*response.response)
    }

    /// Does not work, file upload not implemented yet
    pub async fn update_profile_image(
        &self,
        file: FileData,
    ) -> Result<Image, Error<UpdateProfileImageError>> {
        let response = user_api::update_profile_image(&self.clerk_config(), file).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update((*client).into());
        }
        Ok(*response.response)
    }

    // Waitlist API methods
    pub async fn join_waitlist(
        &self,
        email_address: &str,
    ) -> Result<ClientWaitlistEntry, Error<JoinWaitlistError>> {
        waitlist_api::join_waitlist(&self.clerk_config(), email_address).await
    }

    // Web3 Wallets API methods
    pub async fn attempt_web3_wallet_verification(
        &self,
        web3_wallet_id: &str,
        signature: &str,
        origin: Option<&str>,
    ) -> Result<ClientWeb3Wallet, Error<AttemptWeb3WalletVerificationError>> {
        let response = web3_wallets_api::attempt_web3_wallet_verification(
            &self.clerk_config(),
            web3_wallet_id,
            signature,
            origin,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn delete_web3_wallet(
        &self,
        web3_wallet_id: &str,
    ) -> Result<ClientDeletedObject, Error<DeleteWeb3WalletError>> {
        let response =
            web3_wallets_api::delete_web3_wallet(&self.clerk_config(), web3_wallet_id).await?;
        if let Some(client) = response.client.clone() {
            self.handle_client_update(*client)
        }
        Ok(*response.response)
    }

    pub async fn get_web3_wallets(
        &self,
        clerk_session_id: Option<&str>,
    ) -> Result<Vec<ClientWeb3Wallet>, Error<GetWeb3WalletsError>> {
        web3_wallets_api::get_web3_wallets(&self.clerk_config(), clerk_session_id).await
    }

    pub async fn post_web3_wallets(
        &self,
        web3_wallet: &str,
        _clerk_session_id: Option<&str>,
    ) -> Result<ClientWeb3Wallet, Error<PostWeb3WalletsError>> {
        let response = web3_wallets_api::post_web3_wallets(
            &self.clerk_config(),
            web3_wallet,
            _clerk_session_id,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn prepare_web3_wallet_verification(
        &self,
        web3_wallet_id: &str,
        strategy: &str,
        origin: Option<&str>,
        redirect_url: Option<&str>,
    ) -> Result<ClientWeb3Wallet, Error<PrepareWeb3WalletVerificationError>> {
        let response = web3_wallets_api::prepare_web3_wallet_verification(
            &self.clerk_config(),
            web3_wallet_id,
            strategy,
            origin,
            redirect_url,
        )
        .await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    pub async fn read_web3_wallet(
        &self,
        web3_wallet_id: &str,
    ) -> Result<ClientWeb3Wallet, Error<ReadWeb3WalletError>> {
        let response =
            web3_wallets_api::read_web3_wallet(&self.clerk_config(), web3_wallet_id).await?;
        self.handle_client_update(*response.client.clone());
        Ok(*response.response)
    }

    // Well Known API methods
    pub async fn get_android_asset_links(
        &self,
    ) -> Result<Vec<serde_json::Value>, Error<GetAndroidAssetLinksError>> {
        well_known_api::get_android_asset_links(&self.clerk_config()).await
    }

    pub async fn get_apple_app_site_association(
        &self,
    ) -> Result<WellKnownAppleAppSiteAssociation, Error<GetAppleAppSiteAssociationError>> {
        well_known_api::get_apple_app_site_association(&self.clerk_config()).await
    }

    pub async fn get_jwks(&self) -> Result<Jwks, Error<GetJwksError>> {
        well_known_api::get_jwks(&self.clerk_config()).await
    }

    pub async fn get_o_auth2_authorization_server_metadata(
        &self,
    ) -> Result<
        WellKnownOAuth2AuthorizationServerMetadata,
        Error<GetOAuth2AuthorizationServerMetadataError>,
    > {
        well_known_api::get_o_auth2_authorization_server_metadata(&self.clerk_config()).await
    }

    pub async fn get_open_id_configuration(
        &self,
    ) -> Result<WellKnownOpenIdConfiguration, Error<GetOpenIdConfigurationError>> {
        well_known_api::get_open_id_configuration(&self.clerk_config()).await
    }
}
