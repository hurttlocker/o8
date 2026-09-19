# Engineering Brain routing

In **Settings → Models → Engineering Brain**, choose how o8 pays for Brain answers.

- **Auto** is the default. On an eligible plan, classification and cited answers use managed inference. If that route is unavailable or its allowance is reached, o8 reports the condition. It does not switch to a connected CLI, local model, or BYOK key.
- **Subscription** is an explicit opt-in. It permits the existing connected-CLI Brain routes and may use their quotas.

Free plans keep the existing route behavior in Auto. Existing explicit Brain CLI selections migrate to Subscription. Cached answers may be reused only within the same routing and entitlement state; a setting or entitlement change causes the next uncached answer to use the current route.
