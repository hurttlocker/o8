# Windows release signing

Public Windows releases use Azure Artifact Signing through Tauri's
`bundle.windows.signCommand`. This signs the application executable during the
build and the MSI and EXE installers during bundling. The release workflow then
uses `Get-AuthenticodeSignature` to fail unless every installer is valid.

## One-time publisher setup

1. Create an Azure Artifact Signing account, complete public-trust identity
   validation, and create a certificate profile.
2. Create an application registration with permission to sign through that
   certificate profile.
3. Add these encrypted GitHub Actions secrets to `hurttlocker/o8`:

   - `AZURE_CLIENT_ID`
   - `AZURE_CLIENT_SECRET`
   - `AZURE_TENANT_ID`

4. Add these GitHub Actions variables:

   - `AZURE_ARTIFACT_SIGNING_ACCOUNT`
   - `AZURE_ARTIFACT_SIGNING_ENDPOINT`
   - `AZURE_ARTIFACT_SIGNING_PROFILE`

Microsoft's current setup guide is
[Quickstart: Set up Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/quickstart).
Identity validation is a manual account-owner step and cannot be completed by
the release workflow.

## Build a signed release

Run the `Port Build` workflow against an existing public release tag with
`sign_windows` enabled. Use `replace_existing_assets` only when intentionally
replacing that tag's existing Windows and Linux assets. The workflow installs a
pinned `artifact-signing-cli`, signs through the verified certificate profile,
checks Authenticode status, adds GitHub build-provenance attestations, and then
uploads the release assets.
