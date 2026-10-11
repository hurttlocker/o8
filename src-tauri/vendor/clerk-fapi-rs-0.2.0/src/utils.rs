use std::{error::Error, fmt};

use log::error;

use crate::{
    clerk_fapi::ClerkFapiClient,
    models::{
        ClientClient, ClientClientWrappedOrganizationMembershipsResponse, ClientOrganization,
        ClientOrganizationMembership, ClientSession,
    },
};

pub fn find_organization_id_from_memberships(
    memberships: Vec<ClientOrganizationMembership>,
    organization_id_or_slug: String,
) -> Option<ClientOrganizationMembership> {
    if organization_id_or_slug.starts_with("org_") {
        // It's an organization ID - verify it exists in memberships
        memberships
            .into_iter()
            .find(|m| m.organization.id == organization_id_or_slug)
    } else {
        // It's a slug
        memberships
            .into_iter()
            .find(|m| m.organization.slug == organization_id_or_slug)
    }
}

#[derive(Debug)]
pub enum ClerkOrgFindingError {
    NoUserFound,
    NoMatchFound,
    ClerkApiError,
}
impl fmt::Display for ClerkOrgFindingError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ClerkOrgFindingError::NoUserFound => write!(f, "No user found"),
            ClerkOrgFindingError::NoMatchFound => write!(f, "No match found"),
            ClerkOrgFindingError::ClerkApiError => write!(f, "Clerk API error"),
        }
    }
}
impl Error for ClerkOrgFindingError {}

pub async fn find_target_organization(
    fapi: &ClerkFapiClient,
    session: ClientSession,
    organization_id_or_slug: String,
) -> Result<ClientOrganization, ClerkOrgFindingError> {
    let user = match session.user {
        Some(user) => *user.clone(),
        None => return Err(ClerkOrgFindingError::NoUserFound),
    };

    if let Some(user_org_memberships) = user.organization_memberships {
        if let Some(org) = find_organization_id_from_memberships(
            user_org_memberships,
            organization_id_or_slug.clone(),
        ) {
            return Ok(*org.organization.clone());
        }
    }

    // The organization didn't exist in the current session
    // let's try to find it from the API
    // Let's start by refreshing user
    let user = fapi.get_user().await.map_err(|_| {
        error!("Clerk: failed to get user");
        ClerkOrgFindingError::ClerkApiError
    })?;

    if let Some(user_org_memberships) = user.organization_memberships {
        if let Some(org) = find_organization_id_from_memberships(
            user_org_memberships,
            organization_id_or_slug.clone(),
        ) {
            return Ok(*org.organization.clone());
        }
    }

    // Still no matching organization found!
    // let's try one more time, let's pull the org memberships!
    let user_org_memberships = fapi
        .get_organization_memberships(
            None, // limit
            None, // offset
            None, // paginated
        )
        .await
        .map_err(|_| {
            error!("Clerk: failed to get organization memberships");
            ClerkOrgFindingError::ClerkApiError
        })?;

    if let Some(org) =
        find_organization_id_from_memberships(user_org_memberships, organization_id_or_slug.clone())
    {
        return Ok(*org.organization.clone());
    }

    // We tried our best, we couldn't find organization
    // user was trying to find
    Err(ClerkOrgFindingError::NoMatchFound)
}

#[derive(Debug)]
pub enum ClerkSessionFindingError {
    NoMatchFound,
    NoSession,
}
impl fmt::Display for ClerkSessionFindingError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ClerkSessionFindingError::NoMatchFound => write!(f, "No match found"),
            ClerkSessionFindingError::NoSession => write!(f, "No session found"),
        }
    }
}
impl Error for ClerkSessionFindingError {}

pub fn find_target_session(
    client: ClientClient,
    session_id: String,
) -> Result<ClientSession, ClerkSessionFindingError> {
    client
        .sessions
        .iter()
        .find(|s| s.id == session_id)
        .cloned()
        .ok_or(ClerkSessionFindingError::NoMatchFound)
}
