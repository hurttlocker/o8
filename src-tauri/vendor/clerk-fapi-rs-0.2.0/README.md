# Rust Clerk REST Frontend API

An unofficial Rust SDK for the Clerk REST Frontend API.

## Status

Works and is used in production. But historically there has been some mismatches
with the type definitions and actual behavior, and I haven't used all endpoints,
so if you run into issues open an issue or pr.

Can be used in browsers or non browser environments.

## Core idea

This crate is quite thin wrapper on top of the REST Frontend API. `Clerk` is a
statefull client exposing the full Clerk FAPI methods via `Clerk::get_fapi_client`.
Clerk keeps the client state updated by piggypagging the requests with the current
client state. The methods in the `ClerkFapiClient` will unwrap the requests and
return only the core response and update the client state in `Clerk` stcuct.

The `src/apis` and `src/models` are generated based on the `fapi_swagger.json`.
There seems to have been small issues in the clerk API spec and it has not always
reflected the reality in all of the cases. Those cases where I've run into are
fixed by hand. The models and api methods are also exported so those can be used
directly as well.

### State

By default the state is stored in in `HashMap` but if one wants to add some
persistent state, example to allow offline state, one can provide anything
that implments the `clerk_fapi_rs::configuration::Store` trait.

### Listener

`Clerk` allows to pass in listere callbacks that are calld

The type of lister:

```rs
pub type Listener =
    Arc<dyn Fn(Client, Option<Session>, Option<User>, Option<Organization>) + Send + Sync>;
```

### Utilities

There are only few convenience methods provided directly on the `Clerk`:

- `get_token` to get session token that can be used to authenticate backend calls
- `sign_out` to, well, sign out
- `set_active` to activate session or organization in session

And to read current state there are helper acccess methods:

- `Clerk::environment()` for the current Clerk instance configs
- `Clerk::client()` to access full `ClientClient`
- `Clerk::session()` to access currently active session parsed from `ClientClient`
- `Clerk::user()` to access current user parsed from `ClientClient`
- `Clerk::organization()` to access current organization parsed from `ClientClient`

## Basic Usage

```rust
use clerk_fapi_rs::{clerk::Clerk, configuration::ClerkFapiConfiguration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let public_key = todo!("Load the way you want");

    // Init configuration
    let config = ClerkFapiConfiguration::new(
        public_key, // String
        None,       // proxy
        None,       // domain
    )?;

    // Or in browser
    let config = ClerkFapiConfiguration::new_browser(
        public_key, // String
        None,       // proxy
        None,       // domain
    )?;

    // Or with store
    let config = ClerkFapiConfiguration::new_with_store(
        public_key, // String
        None,       // proxy
        None,       // domain
        Some(Arc::new(my_clerk_store)),
        None,       // store_prefix
        ClientKind::NonBrowser,
    )?;

    // Initialize Clerk client
    let clerk = Clerk::new(config);

    // Load client, it loads the Environment and Client from API
    clerk.load().await?;

    // If one uses persisted store and want to use cached values
    clerk.load(true).await?;

    // Get fapi client
    let fapi = clerk.get_fapi_client();

    // ... do calls with fapi
}
```

## Updating types

1. Get latest defintions from [Clerk docs](https://clerk.com/docs/reference/frontend-api)
   and save as `fapi_swagger.json`
2. use [openapi-generator](https://openapi-generator.tech/) to generate types

```
openapi-generator generate -g rust -i fapi_swagger.json \
  --global-property models,apis,apiTests=false,modelTests=false,apiDocs=false,modelDocs=false
```

3. check that things still work as expected

## Contributing

PR are welcome.

## Release

With [cargo-release](https://crates.io/crates/cargo-release)
