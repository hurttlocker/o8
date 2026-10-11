pub use anyhow::Error as AnyhowError;
pub use std::error;
pub use std::fmt;

#[derive(Debug, Clone)]
pub struct ResponseContent<T> {
    pub status: reqwest::StatusCode,
    pub content: String,
    pub entity: Option<T>,
}

#[derive(Debug)]
pub enum Error<T> {
    Reqwest(reqwest::Error),
    Middleware(AnyhowError),
    Serde(serde_json::Error),
    Io(std::io::Error),
    ResponseError(ResponseContent<T>),
}

impl<T> fmt::Display for Error<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (module, e) = match self {
            Error::Reqwest(e) => ("reqwest", e.to_string()),
            Error::Middleware(e) => ("middleware", e.to_string()),
            Error::Serde(e) => ("serde", e.to_string()),
            Error::Io(e) => ("IO", e.to_string()),
            Error::ResponseError(e) => ("response", format!("status code {}", e.status)),
        };
        write!(f, "error in {module}: {e}")
    }
}

impl<T: fmt::Debug> error::Error for Error<T> {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        Some(match self {
            Error::Reqwest(e) => e,
            Error::Middleware(e) => e.as_ref(),
            Error::Serde(e) => e,
            Error::Io(e) => e,
            Error::ResponseError(_) => return None,
        })
    }
}

impl<T> From<reqwest::Error> for Error<T> {
    fn from(e: reqwest::Error) -> Self {
        Error::Reqwest(e)
    }
}

impl<T> From<serde_json::Error> for Error<T> {
    fn from(e: serde_json::Error) -> Self {
        Error::Serde(e)
    }
}

impl<T> From<std::io::Error> for Error<T> {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

impl<T> From<anyhow::Error> for Error<T> {
    fn from(e: anyhow::Error) -> Self {
        Error::Middleware(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentType {
    Json,
    Text,
    Unsupported(String),
}

impl From<&str> for ContentType {
    fn from(s: &str) -> Self {
        if s.contains("application/json") {
            ContentType::Json
        } else if s.contains("text/plain") {
            ContentType::Text
        } else {
            ContentType::Unsupported(s.to_string())
        }
    }
}

pub fn urlencode<T: AsRef<str>>(s: T) -> String {
    ::url::form_urlencoded::byte_serialize(s.as_ref().as_bytes()).collect()
}

pub fn parse_deep_object(prefix: &str, value: &serde_json::Value) -> Vec<(String, String)> {
    if let serde_json::Value::Object(object) = value {
        let mut params = vec![];

        for (key, value) in object {
            match value {
                serde_json::Value::Object(_) => {
                    params.append(&mut parse_deep_object(&format!("{prefix}[{key}]"), value))
                }
                serde_json::Value::Array(array) => {
                    for (i, value) in array.iter().enumerate() {
                        params.append(&mut parse_deep_object(
                            &format!("{prefix}[{key}][{i}]"),
                            value,
                        ));
                    }
                }
                serde_json::Value::String(s) => {
                    params.push((format!("{prefix}[{key}]"), s.clone()))
                }
                _ => params.push((format!("{prefix}[{key}]"), value.to_string())),
            }
        }

        return params;
    }

    unimplemented!("Only objects are supported with style=deepObject")
}

// Simple in memory file for profile picture uploads
#[derive(Debug, Clone)]
pub struct FileData {
    pub name: String,
    pub data: Vec<u8>,
    pub mime_type: String,
}

pub mod active_sessions_api;
pub use self::active_sessions_api::{GetSessionsError, GetUsersSessionsError, RevokeSessionError};
pub mod backup_codes_api;
pub use self::backup_codes_api::CreateBackupCodesError;
pub mod client_api;
pub use self::client_api::{
    DeleteClientSessionsError, GetClientError, HandshakeClientError, PostClientError,
    PutClientError,
};
pub mod configuration;
pub use self::configuration::Configuration as ApiConfiguration;
pub mod default_api;
pub use self::default_api::{
    ClearSiteDataError, GetAccountPortalError, GetDevBrowserInitError, GetProxyHealthError,
    LinkClientError, PostDevBrowserInitSetCookieError, SyncClientError,
};
pub mod dev_browser_api;
pub use self::dev_browser_api::CreateDevBrowserError;
pub mod domains_api;
pub use self::domains_api::{
    AttemptOrganizationDomainVerificationError, CreateOrganizationDomainError,
    DeleteOrganizationDomainError, GetOrganizationDomainError, ListOrganizationDomainsError,
    PrepareOrganizationDomainVerificationError, UpdateOrganizationDomainEnrollmentModeError,
};
pub mod email_addresses_api;
pub use self::email_addresses_api::{
    CreateEmailAddressesError, DeleteEmailAddressError, GetEmailAddressError,
    GetEmailAddressesError, SendVerificationEmailError, VerifyEmailAddressError,
};
pub mod environment_api;
pub use self::environment_api::{GetEnvironmentError, UpdateEnvironmentError};
pub mod external_accounts_api;
pub use self::external_accounts_api::{
    DeleteExternalAccountError, PostOAuthAccountsError, ReauthorizeExternalAccountError,
    RevokeExternalAccountTokensError,
};
pub mod health_api;
pub use self::health_api::GetHealthError;
pub mod invitations_api;
pub use self::invitations_api::{
    BulkCreateOrganizationInvitationsError, CreateOrganizationInvitationsError,
    GetAllPendingOrganizationInvitationsError, GetOrganizationInvitationsError,
    RevokePendingOrganizationInvitationError,
};
pub mod members_api;
pub use self::members_api::{
    CreateOrganizationMembershipError, ListOrganizationMembershipsError,
    RemoveOrganizationMemberError, UpdateOrganizationMembershipError,
};
pub mod membership_requests_api;
pub use self::membership_requests_api::{
    AcceptOrganizationMembershipRequestError, ListOrganizationMembershipRequestsError,
    RejectOrganizationMembershipRequestError,
};
pub mod o_auth2_callbacks_api;
pub use self::o_auth2_callbacks_api::{GetOauthCallbackError, PostOauthCallbackError};
pub mod o_auth2_identify_provider_api;
pub use self::o_auth2_identify_provider_api::{
    GetOAuthConsentError, GetOAuthTokenError, GetOAuthTokenInfoError, GetOAuthUserInfoError,
    GetOAuthUserInfoPostError, RequestOAuthAuthorizeError, RequestOAuthAuthorizePostError,
    RevokeOAuthTokenError,
};
pub mod organization_api;
pub use self::organization_api::{
    CreateOrganizationError, DeleteOrganizationError, DeleteOrganizationLogoError,
    GetOrganizationError, UpdateOrganizationError, UpdateOrganizationLogoError,
};
pub mod organizations_memberships_api;
pub use self::organizations_memberships_api::{
    AcceptOrganizationInvitationError, AcceptOrganizationSuggestionError,
    DeleteOrganizationMembershipsError, GetOrganizationMembershipsError,
    GetOrganizationSuggestionsError, GetUsersOrganizationInvitationsError,
};
pub mod passkeys_api;
pub use self::passkeys_api::{
    AttemptPasskeyVerificationError, DeletePasskeyError, PatchPasskeyError, PostPasskeyError,
    ReadPasskeyError,
};
pub mod phone_numbers_api;
pub use self::phone_numbers_api::{
    DeletePhoneNumberError, GetPhoneNumbersError, PostPhoneNumbersError, ReadPhoneNumberError,
    SendVerificationSmsError, UpdatePhoneNumberError, VerifyPhoneNumberError,
};
pub mod redirect_api;
pub use self::redirect_api::RedirectToUrlError;
pub mod roles_api;
pub use self::roles_api::ListOrganizationRolesError;
pub mod saml_api;
pub use self::saml_api::{AcsError, SamlMetadataError};
pub mod sessions_api;
pub use self::sessions_api::{
    AttemptSessionReverificationFirstFactorError, AttemptSessionReverificationSecondFactorError,
    CreateSessionTokenError, CreateSessionTokenWithTemplateError, EndSessionError, GetSessionError,
    PrepareSessionReverificationFirstFactorError, PrepareSessionReverificationSecondFactorError,
    RemoveClientSessionsAndRetainCookieError, RemoveSessionError, StartSessionReverificationError,
    TouchSessionError,
};
pub mod sign_ins_api;
pub use self::sign_ins_api::{
    AcceptTicketError, AttemptSignInFactorOneError, AttemptSignInFactorTwoError, CreateSignInError,
    GetSignInError, PrepareSignInFactorOneError, PrepareSignInFactorTwoError, ResetPasswordError,
    VerifyError,
};
pub mod sign_ups_api;
pub use self::sign_ups_api::{
    AttemptSignUpsVerificationError, CreateSignUpsError, GetSignUpsError,
    PrepareSignUpsVerificationError, UpdateSignUpsError,
};
pub mod totp_api;
pub use self::totp_api::{DeleteTotpError, PostTotpError, VerifyTotpError};
pub mod user_api;
pub use self::user_api::{
    ChangePasswordError, CreateServiceTokenError, DeleteProfileImageError, DeleteUserError,
    GetUserError, PatchUserError, RemovePasswordError, UpdateProfileImageError,
};
pub mod waitlist_api;
pub use self::waitlist_api::JoinWaitlistError;
pub mod web3_wallets_api;
pub use self::web3_wallets_api::{
    AttemptWeb3WalletVerificationError, DeleteWeb3WalletError, GetWeb3WalletsError,
    PostWeb3WalletsError, PrepareWeb3WalletVerificationError, ReadWeb3WalletError,
};
pub mod well_known_api;
pub use self::well_known_api::{
    GetAndroidAssetLinksError, GetAppleAppSiteAssociationError, GetJwksError,
    GetOAuth2AuthorizationServerMetadataError, GetOpenIdConfigurationError,
};
