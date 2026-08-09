param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

$ErrorActionPreference = 'Stop'

$required = @(
  'AZURE_ARTIFACT_SIGNING_ACCOUNT',
  'AZURE_ARTIFACT_SIGNING_ENDPOINT',
  'AZURE_ARTIFACT_SIGNING_PROFILE',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID'
)
foreach ($name in $required) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Windows release signing value $name is not configured"
  }
}

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
  throw "Windows signing target does not exist: $FilePath"
}

& artifact-signing-cli `
  -e $env:AZURE_ARTIFACT_SIGNING_ENDPOINT `
  -a $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
  -c $env:AZURE_ARTIFACT_SIGNING_PROFILE `
  -d 'o8' `
  $FilePath

if ($LASTEXITCODE -ne 0) {
  throw "Artifact Signing failed for $FilePath with exit code $LASTEXITCODE"
}
