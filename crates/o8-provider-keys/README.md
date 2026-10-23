# Local provider credentials

Node and native readers share `<resolved data directory>/.env.local`. Provider lines use
`NAME=enc:<12-byte IV as hex>:<AES-256-GCM ciphertext and 16-byte tag as hex>`.
The same 32-byte master key is resolved from the explicit master-key environment override,
macOS Keychain, or an existing permission-restricted fallback key file. Non-macOS first use
creates a random fallback file; this provides encryption at rest, not OS credential-vault protection.

`O8_KEY_MANAGED_NAME=1` makes a saved credential or removal authoritative over ambient and
legacy values. `O8_KEY_DISABLED_NAME=1` disables the credential without removing ciphertext.
The old nonsecret OpenRouter connection record remains the fallback for installations without
an explicit enable/disable marker and retains key-check metadata.

Both writers serialize read/modify/atomic-rename operations with a SQLite `BEGIN EXCLUSIVE`
transaction on `.provider-keys.lock`. That database contains no credentials. OS locks are
released on process exit. A failed read, authentication tag, master-key access or lock acquisition
rejects the mutation. Existing ciphertext and unrelated configuration lines are preserved.
Supported legacy plaintext is encrypted during a successful mutation. Native legacy migration
checks eligibility while holding the same lock, so it cannot overwrite a newer save or removal.

Provider credentials stay in the local backend. Inventory returns masked values; native
preferences return presence flags. CLI subscription credentials remain owned by their runtimes.
